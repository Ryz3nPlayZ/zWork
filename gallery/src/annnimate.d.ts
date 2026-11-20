// The Annnimate components are plain JSX with JSDoc; the gallery passes them
// props as data, so they are typed loosely here instead of inferred.
declare module "*.jsx" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C: any;
  export default C;
}
