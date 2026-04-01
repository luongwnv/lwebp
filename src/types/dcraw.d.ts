declare module 'dcraw' {
  interface DcrawOptions {
    exportAsTiff?: boolean;
    verbose?: boolean;
  }
  function dcraw(buffer: Buffer, options?: DcrawOptions): Buffer;
  export = dcraw;
}
