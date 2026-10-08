// 암호 걸린 docx·xlsx·pptx를 워커에서 푼다. 암호 키를 만드는 해시 10만 번 반복이 화면을 멈추지 않게 한다.
// 'open'으로 문서를 한 번 넘기고, 'decrypt'로 암호를 여러 번 시도할 수 있다.
import { readCompound } from '../containers.js';
import { decryptOoxml, WrongPasswordError } from '../office-crypto.js';

let info = null;
let pkg = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'open') {
      const cfb = readCompound(new Uint8Array(data.bytes));
      info = cfb.read('EncryptionInfo');
      pkg = cfb.read('EncryptedPackage');
      if (!info || !pkg) throw new Error('암호화 스트림이 없습니다');
      self.postMessage({ type: 'opened' });
    } else if (data.type === 'decrypt') {
      let zip;
      try {
        zip = decryptOoxml(info, pkg, data.password);
      } catch (error) {
        if (!(error instanceof WrongPasswordError)) throw error;
        self.postMessage({ type: 'decrypted', wrong: true });
        return;
      }
      const exact = zip.byteOffset === 0 && zip.byteLength === zip.buffer.byteLength ? zip : zip.slice();
      self.postMessage({ type: 'decrypted', zip: exact.buffer }, [exact.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
