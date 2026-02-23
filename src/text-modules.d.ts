// Text module imports via wrangler rules
declare module "*.txt" {
  const content: string;
  export default content;
}
