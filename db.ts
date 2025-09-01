import { Low, JSONFile } from '@commonify/lowdb';
import { join } from 'path';

const dbPath = join(__dirname, 'tokens.json');
const adapter = new JSONFile(dbPath);
const db = new Low(adapter);

await db.read();

if (!db.data) {
    db.data = { tokens: [] };
    await db.write();
}

export default db;
