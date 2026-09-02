/**
 * Type declarations for `@oathpath/shared`, hand-written because this package has no
 * build step (see the long note at the top of `index.js` for why).
 *
 * Deliberately typed as `string` and NOT as the string literal. A literal type
 * would let a consumer — or, more likely, a test — depend on the current VALUE
 * at the type level, so renaming the app would turn into a typecheck failure
 * somewhere far away from this package. The whole point is that the value is
 * free to change.
 */
export declare const APP_NAME: string;
