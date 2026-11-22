/** Parses JSON that may contain comments and trailing commas, as tsconfig.json files do. */
export function parseJsonWithComments(text: string): unknown {
    let plain = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];
        if (char === '"') {
            const start = index++;
            while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
            plain += text.slice(start, ++index);
        } else if (char === '/' && next === '/') {
            while (index < text.length && text[index] !== '\n') index++;
        } else if (char === '/' && next === '*') {
            const end = text.indexOf('*/', index + 2);
            index = end < 0 ? text.length : end + 2;
        } else {
            if ((char === '}' || char === ']') && plain.trimEnd().endsWith(',')) plain = plain.trimEnd().slice(0, -1);
            plain += char;
            index++;
        }
    }
    return JSON.parse(plain);
}
