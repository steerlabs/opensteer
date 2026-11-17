/** This phone's owner check didn't pass, in words written for the person. */
export class DeviceOwnerUnconfirmed extends Error {
  constructor(readonly words: string) {
    super(words);
  }
}
