import { readFileSync } from 'fs';
import { join } from 'path';

const dir = join(__dirname, '..', 'fixtures');

export const selfSignedTls = () => ({
  key: readFileSync(join(dir, 'key.pem')),
  cert: readFileSync(join(dir, 'cert.pem')),
});
