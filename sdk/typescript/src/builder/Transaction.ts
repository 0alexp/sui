// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fromB64 } from '@mysten/bcs';
import { is } from 'superstruct';
import { Provider } from '../providers/provider';
import {
  extractMutableReference,
  extractStructTag,
  getObjectReference,
  getSharedObjectInitialVersion,
  normalizeSuiObjectId,
  ObjectId,
  SuiMoveNormalizedType,
  SuiObjectRef,
  SUI_TYPE_ARG,
} from '../types';
import {
  Commands,
  CommandArgument,
  TransactionCommand,
  TransactionInput,
  getTransactionCommandType,
  MoveCallCommand,
} from './Commands';
import {
  BuilderCallArg,
  getIdFromCallArg,
  Inputs,
  isMutableSharedObjectInput,
  ObjectCallArg,
} from './Inputs';
import { getPureSerializationType, isTxContext } from './serializer';
import {
  TransactionDataBuilder,
  TransactionExpiration,
} from './TransactionData';
import { COMMAND_TYPE, create, WellKnownEncoding } from './utils';

type TransactionResult = CommandArgument & CommandArgument[];

function createTransactionResult(index: number): TransactionResult {
  const baseResult: CommandArgument = { kind: 'Result', index };

  const nestedResults: CommandArgument[] = [];
  const nestedResultFor = (resultIndex: number): CommandArgument =>
    (nestedResults[resultIndex] ??= {
      kind: 'NestedResult',
      index,
      resultIndex,
    });

  return new Proxy(baseResult, {
    set() {
      throw new Error(
        'The transaction result is a proxy, and does not support setting properties directly',
      );
    },
    // TODO: Instead of making this return a concrete argument, we should ideally
    // make it reference-based (so that this gets resolved at build-time), which
    // allows re-ordering transactions.
    get(target, property) {
      // This allows this transaction argument to be used in the singular form:
      if (property in target) {
        return Reflect.get(target, property);
      }

      // Support destructuring:
      if (property === Symbol.iterator) {
        return function* () {
          let i = 0;
          while (true) {
            yield nestedResultFor(i);
            i++;
          }
        };
      }

      if (typeof property === 'symbol') return;

      const resultIndex = parseInt(property, 10);
      if (Number.isNaN(resultIndex) || resultIndex < 0) return;
      return nestedResultFor(resultIndex);
    },
  }) as TransactionResult;
}

function expectProvider(provider: Provider | undefined): Provider {
  if (!provider) {
    throw new Error(
      `No provider passed to Transaction#build, but transaction data was not sufficient to build offline.`,
    );
  }

  return provider;
}

const TRANSACTION_BRAND = Symbol.for('@mysten/transaction');

/**
 * Transaction Builder
 * @experimental
 */
export class Transaction {
  /** Returns `true` if the object is an instance of the Transaction builder class. */
  static is(obj: unknown): obj is Transaction {
    return (
      !!obj &&
      typeof obj === 'object' &&
      (obj as any)[TRANSACTION_BRAND] === true
    );
  }

  /**
   * Converts from a serialized transaction format to a `Transaction` class.
   * There are two supported serialized formats:
   * - A string returned from `Transaction#serialize`. The serialized format must be compatible, or it will throw an error.
   * - A byte array (or base64-encoded bytes) containing BCS transaction data.
   */
  static from(serialized: string | Uint8Array) {
    const tx = new Transaction();

    // Check for bytes:
    if (typeof serialized !== 'string' || !serialized.startsWith('{')) {
      tx.#transactionData = TransactionDataBuilder.fromBytes(
        typeof serialized === 'string' ? fromB64(serialized) : serialized,
      );
    } else {
      tx.#transactionData = TransactionDataBuilder.restore(
        JSON.parse(serialized),
      );
    }

    return tx;
  }

  /** A helper to retrieve the Transaction builder `Commands` */
  static get Commands() {
    return Commands;
  }

  /** A helper to retrieve the Transaction builder `Inputs` */
  static get Inputs() {
    return Inputs;
  }

  setSender(sender: string) {
    this.#transactionData.sender = sender;
  }
  setExpiration(expiration?: TransactionExpiration) {
    this.#transactionData.expiration = expiration;
  }
  setGasPrice(price: number | bigint) {
    this.#transactionData.gasConfig.price = String(price);
  }
  setGasBudget(budget: number | bigint) {
    this.#transactionData.gasConfig.budget = String(budget);
  }
  setGasPayment(payment: SuiObjectRef[]) {
    this.#transactionData.gasConfig.payment = payment;
  }

  #transactionData: TransactionDataBuilder;
  /** Get a snapshot of the transaction data, in JSON form: */
  get transactionData() {
    return this.#transactionData.snapshot();
  }

  // Used to brand transaction classes so that they can be identified, even between multiple copies
  // of the builder.
  get [TRANSACTION_BRAND]() {
    return true;
  }

  constructor(transaction?: Transaction) {
    this.#transactionData = new TransactionDataBuilder(
      transaction ? transaction.#transactionData : undefined,
    );
  }

  /** Returns an argument for the gas coin, to be used in a transaction. */
  get gas(): CommandArgument {
    return { kind: 'GasCoin' };
  }

  /**
   * Dynamically create a new input, which is separate from the `input`. This is important
   * for generated clients to be able to define unique inputs that are non-overlapping with the
   * defined inputs.
   *
   * For `Uint8Array` type automatically convert the input into a `Pure` CallArg, since this
   * is the format required for custom serialization.
   *
   */
  #input(type: 'object' | 'pure', value?: unknown) {
    const index = this.#transactionData.inputs.length;
    const input = create(
      { kind: 'Input', value, index, type },
      TransactionInput,
    );
    this.#transactionData.inputs.push(input);
    return input;
  }

  /**
   * Add a new object input to the transaction.
   */
  object(value: ObjectId | ObjectCallArg) {
    const id = getIdFromCallArg(value);
    // deduplicate
    const inserted = this.#transactionData.inputs.find(
      (i) => i.type === 'object' && id === getIdFromCallArg(i.value),
    );
    return inserted ?? this.#input('object', value);
  }

  /**
   * Add a new non-object input to the transaction.
   *
   * TODO: take an optional second type parameter here and do the BCS encoding into the
   * fully-resolved type if folks happen to know the pure type encoding.
   */
  pure(value: unknown) {
    // TODO: we can also do some deduplication here
    return this.#input('pure', value);
  }

  // TODO: Currently, tx.input() takes in both fully-resolved input values, and partially-resolved input values.
  // We could also simplify the transaction building quite a bit if we force folks to use fully-resolved pure types
  // always, and just offer object building through some API like `tx.object()`, which we can just track slightly
  // different internally.

  /** Add a command to the transaction. */
  add(command: TransactionCommand) {
    // TODO: This should also look at the command arguments and add any referenced commands that are not present in this transaction.
    const index = this.#transactionData.commands.push(command);
    return createTransactionResult(index - 1);
  }

  /**
   * Serialize the transaction to a string so that it can be sent to a separate context.
   * This is different from `build` in that it does not serialize to BCS bytes, and instead
   * uses a separate format that is unique to the transaction builder. This allows
   * us to serialize partially-complete transactions, that can then be completed and
   * built in a separate context.
   *
   * For example, a dapp can construct a transaction, but not provide gas objects
   * or a gas budget. The transaction then can be sent to the wallet, where this
   * information is automatically filled in (e.g. by querying for coin objects
   * and performing a dry run).
   */
  serialize() {
    return JSON.stringify(this.#transactionData.snapshot());
  }

  /** Build the transaction to BCS bytes. */
  async build({
    provider,
    onlyTransactionKind,
  }: {
    provider?: Provider;
    onlyTransactionKind?: boolean;
  } = {}): Promise<Uint8Array> {
    await this.#prepare(provider);
    return this.#transactionData.build({ onlyTransactionKind });
  }

  /** Derive transaction digest */
  async getDigest({
    provider,
  }: {
    provider?: Provider;
  } = {}): Promise<string> {
    await this.#prepare(provider);
    return this.#transactionData.getDigest();
  }

  /**
   * Prepare the transaction by valdiating the transaction data and resolving all inputs
   * so that it can be built into bytes.
   */
  async #prepare(provider?: Provider) {
    if (!this.#transactionData.sender) {
      throw new Error('Missing transaction sender');
    }

    if (!this.#transactionData.gasConfig.budget) {
      throw new Error('Missing gas budget');
    }

    if (!this.#transactionData.gasConfig.price) {
      this.#transactionData.gasConfig.price = String(
        await expectProvider(provider).getReferenceGasPrice(),
      );
    }

    const { inputs, commands } = this.#transactionData;

    const moveModulesToResolve: MoveCallCommand[] = [];

    // Keep track of the object references that will need to be resolved at the end of the transaction.
    // We keep the input by-reference to avoid needing to re-resolve it:
    const objectsToResolve: {
      id: string;
      input: TransactionInput;
      normalizedType?: SuiMoveNormalizedType;
    }[] = [];

    commands.forEach((command) => {
      // Special case move call:
      if (command.kind === 'MoveCall') {
        // Determine if any of the arguments require encoding.
        // - If they don't, then this is good to go.
        // - If they do, then we need to fetch the normalized move module.
        const needsResolution = command.arguments.some(
          (arg) =>
            arg.kind === 'Input' &&
            !is(inputs[arg.index].value, BuilderCallArg),
        );

        if (needsResolution) {
          moveModulesToResolve.push(command);
        }

        return;
      }

      // Get the matching struct definition for the command, and use it to attempt to automatically
      // encode the matching inputs.
      const commandType = getTransactionCommandType(command);
      if (!commandType.schema) return;

      Object.entries(command).forEach(([key, value]) => {
        if (key === 'kind') return;
        const keySchema = (commandType.schema as any)[key];
        const isArray = keySchema.type === 'array';
        const wellKnownEncoding: WellKnownEncoding = isArray
          ? keySchema.schema[COMMAND_TYPE]
          : keySchema[COMMAND_TYPE];

        // This argument has unknown encoding, assume it must be fully-encoded:
        if (!wellKnownEncoding) return;

        const encodeInput = (index: number) => {
          const input = inputs[index];
          if (!input) {
            throw new Error(`Missing input ${value.index}`);
          }

          // Input is fully resolved:
          if (is(input.value, BuilderCallArg)) return;
          if (
            wellKnownEncoding.kind === 'object' &&
            typeof input.value === 'string'
          ) {
            // The input is a string that we need to resolve to an object reference:
            objectsToResolve.push({ id: input.value, input });
          } else if (wellKnownEncoding.kind === 'pure') {
            // Pure encoding, so construct BCS bytes:
            input.value = Inputs.Pure(wellKnownEncoding.type, input.value);
          } else {
            throw new Error('Unexpected input format.');
          }
        };

        if (isArray) {
          value.forEach((arrayItem: CommandArgument) => {
            if (arrayItem.kind !== 'Input') return;
            encodeInput(arrayItem.index);
          });
        } else {
          if (value.kind !== 'Input') return;
          encodeInput(value.index);
        }
      });
    });

    if (moveModulesToResolve.length) {
      await Promise.all(
        moveModulesToResolve.map(async (moveCall) => {
          const [packageId, moduleName, functionName] =
            moveCall.target.split('::');

          const normalized = await expectProvider(
            provider,
          ).getNormalizedMoveFunction(
            normalizeSuiObjectId(packageId),
            moduleName,
            functionName,
          );

          // Entry functions can have a mutable reference to an instance of the TxContext
          // struct defined in the TxContext module as the last parameter. The caller of
          // the function does not need to pass it in as an argument.
          const hasTxContext =
            normalized.parameters.length > 0 &&
            isTxContext(normalized.parameters.at(-1)!);

          const params = hasTxContext
            ? normalized.parameters.slice(0, normalized.parameters.length - 1)
            : normalized.parameters;

          if (params.length !== moveCall.arguments.length) {
            throw new Error('Incorrect number of arguments.');
          }

          params.forEach((param, i) => {
            const arg = moveCall.arguments[i];
            if (arg.kind !== 'Input') return;
            const input = inputs[arg.index];
            // Skip if the input is already resolved
            if (is(input, BuilderCallArg)) return;

            const inputValue = input.value;

            const serType = getPureSerializationType(param, inputValue);

            if (serType) {
              input.value = Inputs.Pure(serType, inputValue);
              return;
            }

            const structVal = extractStructTag(param);
            if (
              structVal != null ||
              (typeof param === 'object' && 'TypeParameter' in param)
            ) {
              if (typeof inputValue !== 'string') {
                throw new Error(
                  `Expect the argument to be an object id string, got ${JSON.stringify(
                    inputValue,
                    null,
                    2,
                  )}`,
                );
              }
              objectsToResolve.push({
                id: inputValue,
                input,
                normalizedType: param,
              });
              return;
            }

            throw new Error(
              `Unknown call arg type ${JSON.stringify(
                param,
                null,
                2,
              )} for value ${JSON.stringify(inputValue, null, 2)}`,
            );
          });
        }),
      );
    }

    if (objectsToResolve.length) {
      const dedupedIds = [...new Set(objectsToResolve.map(({ id }) => id))];
      const objects = await expectProvider(provider).getObjectBatch(
        dedupedIds,
        { showOwner: true },
      );
      let objectsById = new Map(
        dedupedIds.map((id, index) => {
          return [id, objects[index]];
        }),
      );

      const invalidObjects = Array.from(objectsById)
        .filter(([_, obj]) => obj.status !== 'Exists')
        .map(([id, _]) => id);
      if (invalidObjects.length) {
        throw new Error(
          `The following input objects are not invalid: ${invalidObjects.join(
            ', ',
          )}`,
        );
      }

      objectsToResolve.forEach(({ id, input, normalizedType }) => {
        const object = objectsById.get(id)!;
        const initialSharedVersion = getSharedObjectInitialVersion(object);

        if (initialSharedVersion) {
          // There could be multiple commands that reference the same shared object.
          // If one of them is a mutable reference, then we should mark the input
          // as mutable.
          const mutable =
            isMutableSharedObjectInput(input.value) ||
            (normalizedType != null &&
              extractMutableReference(normalizedType) != null);

          input.value = Inputs.SharedObjectRef({
            objectId: id,
            initialSharedVersion,
            mutable,
          });
        } else {
          input.value = Inputs.ObjectRef(getObjectReference(object)!);
        }
      });
    }

    if (!this.#transactionData.gasConfig.payment) {
      const coins = await expectProvider(provider).getCoins({
        owner: this.#transactionData.sender,
        coinType: SUI_TYPE_ARG,
      });

      // TODO: Allow consumers to define coin selection logic, and refine the default behavior.
      // The current default is just picking _all_ coins which may not be ideal.
      this.#transactionData.gasConfig.payment = coins.data
        // Filter out coins that are also used as input:
        .filter((coin) => {
          const matchingInput = this.#transactionData.inputs.find((input) => {
            if (
              is(input.value, BuilderCallArg) &&
              'Object' in input.value &&
              'ImmOrOwned' in input.value.Object
            ) {
              return (
                coin.coinObjectId === input.value.Object.ImmOrOwned.objectId
              );
            }

            return false;
          });

          return !matchingInput;
        })
        .map((coin) => ({
          objectId: coin.coinObjectId,
          digest: coin.digest,
          version: coin.version,
        }));

      if (!this.#transactionData.gasConfig.payment.length) {
        throw new Error('No valid gas coins found for the transaction.');
      }
    }
  }
}
