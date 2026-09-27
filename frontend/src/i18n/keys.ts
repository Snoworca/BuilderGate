// Type-only: the English catalog is the key source of truth and never enters the bundle.
type EnKey = keyof typeof import('../../public/locales/messages.en.json');

/** Base keys of plural families: `x.count` when `x.count.one`/`x.count.other` exist. */
export type PluralKey = EnKey extends infer K ? (K extends `${infer B}.other` ? B : never) : never;

/** Keys `t()` accepts — plural category keys are reached only through `tn()`. */
export type MessageKey = Exclude<EnKey, `${PluralKey}.${string}`>;
