/** This phone's owner check didn't pass, in words written for the person. */
export class DeviceOwnerUnconfirmed extends Error {
  readonly words: string;
  constructor(words: string) {
    super(words);
    this.words = words;
  }
}
