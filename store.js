import { writeFileSync, readFileSync, existsSync } from 'fs';

export function makeInMemoryStore({ logger }) {
    const chats = {};
    const messages = {};
    const contacts = {};

    const bind = (ev) => {
        ev.on('contacts.upsert', (newContacts) => {
            for (const contact of newContacts) {
                contacts[contact.id] = { ...(contacts[contact.id] || {}), ...contact };
            }
        });
        ev.on('contacts.update', (updates) => {
            for (const update of updates) {
                if (contacts[update.id]) {
                    Object.assign(contacts[update.id], update);
                }
            }
        });
    };

    const writeToFile = (path) => {
        try {
            writeFileSync(path, JSON.stringify({ chats, contacts, messages }, null, 2));
        } catch (error) {
            if (logger) logger.error({ error }, 'failed to save store');
        }
    };

    const readFromFile = (path) => {
        try {
            if (existsSync(path)) {
                const data = JSON.parse(readFileSync(path, { encoding: 'utf-8' }));
                Object.assign(chats, data.chats);
                Object.assign(contacts, data.contacts);
                Object.assign(messages, data.messages);
            }
        } catch (error) {
            if (logger) logger.error({ error }, 'failed to read store');
        }
    };

    return {
        chats,
        contacts,
        messages,
        bind,
        writeToFile,
        readFromFile
    };
}
