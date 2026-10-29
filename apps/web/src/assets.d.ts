/** Vite resolves an imported asset to the URL it will be served from. */
declare module "*.png?url" {
  const url: string;
  export default url;
}
