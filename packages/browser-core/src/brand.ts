declare const brandSymbol: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brandSymbol]: Name;
};

export function brand<Value, Name extends string>(value: Value): Brand<Value, Name> {
  return value as Brand<Value, Name>;
}
