import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// Based on "Storage Combinators" paper.

/**
 * A Store that keeps data in an in-memory Map.
 * This is analogous to DictStore from the paper.
 */
class DictStore<T> implements Store<T> {
    private readonly data = new Map<string, T>();

    async get(ref: string): Promise<T | null> {
        return this.data.get(ref) ?? null;
    }

    async put(ref: string, data: T): Promise<void> {
        this.data.set(ref, data);
    }

    async delete(ref: string): Promise<void> {
        this.data.delete(ref);
    }
}

/**
 * The Store interface, based on the Storage protocol from Figure 3.
 * It provides a generic, REST-like interface for accessing data.
 */
interface Store<T> {
    get(ref: string): Promise<T | null>;
    put(ref: string, data: T): Promise<void>;
    delete(ref: string): Promise<void>;
}

/**
 * A Store for fetching resources over HTTP.
 * This acts as our primary data source.
 */
class HttpStore implements Store<string> {
    private readonly baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async get(ref: string): Promise<string | null> {
        try {
            const response = await fetch(`${this.baseUrl}/${ref}`);
            if (!response.ok) {
                // 404 is treated as a valid "not found" response.
                if (response.status === 404) {
                    return null;
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.text();
        } catch (error) {
            console.error(`HttpStore get failed for ref '${ref}':`, error);
            return null;
        }
    }

    put(ref: string, data: string): Promise<void> {
        // A simple read-only source doesn't implement put/delete.
        throw new Error("HttpStore is read-only.");
    }

    delete(ref: string): Promise<void> {
        throw new Error("HttpStore is read-only.");
    }
}

/**
 * A Store for the local file system using node:fs/promises.
 * This will serve as our cache.
 */
class DiskStore implements Store<string> {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    private getPath(ref: string): string {
        // Sanitize ref to prevent directory traversal attacks.
        const safeRef = path.normalize(ref).replace(/^(\.\.[\/\\])+/, '');
        return path.join(this.baseDir, safeRef);
    }

    async get(ref: string): Promise<string | null> {
        try {
            const filePath = this.getPath(ref);
            return await fs.readFile(filePath, 'utf-8');
        } catch (error: any) {
            // A missing file is a cache miss, not an error.
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async put(ref: string, data: string): Promise<void> {
        const filePath = this.getPath(ref);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, data, 'utf-8');
    }

    async delete(ref: string): Promise<void> {
        try {
            await fs.unlink(this.getPath(ref));
        } catch (error: any) {
            // It's not an error if the file to delete doesn't exist.
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
}

/**
 * A CachingStore combinator, based on Figure 18.
 * It combines a source store and a cache store.
 */
class CachingStore<T> implements Store<T> {
    private readonly source: Store<T>;
    private readonly cache: Store<T>;

    constructor(source: Store<T>, cache: Store<T>) {
        this.source = source;
        this.cache = cache;
    }

    async get(ref: string): Promise<T | null> {
        // Try to get data from cache first.
        let data = await this.cache.get(ref);
        if (data !== null) {
            return data;
        }

        // On a miss, get data from the source.
        data = await this.source.get(ref);

        // If source returned data, store it in the cache for next time.
        if (data !== null) {
            await this.cache.put(ref, data);
        }

        return data;
    }

    async put(ref: string, data: T): Promise<void> {
        // This is a write-through cache. Write to both cache and source.
        await this.cache.put(ref, data);
        await this.source.put(ref, data);
    }

    async delete(ref: string): Promise<void> {
        // Delete from both cache and source.
        await this.cache.delete(ref);
        await this.source.delete(ref);
    }
}

/**
 * A LoggingStore combinator, based on Figure 19.
 * It's a pass-through store that logs operations.
 */
type LogFormatter = (operation: string, ref: string) => string;

class LoggingStore<T> implements Store<T> {
    private readonly source: Store<T>;
    private readonly log: { write: (message: string) => void };
    private readonly formatter: LogFormatter;

    constructor(source: Store<T>, log: { write: (message: string) => void }, formatter: LogFormatter) {
        this.source = source;
        this.log = log;
        this.formatter = formatter;
    }

    async get(ref: string): Promise<T | null> {
        this.log.write(this.formatter('GET', ref));
        return this.source.get(ref);
    }

    async put(ref: string, data: T): Promise<void> {
        this.log.write(this.formatter('PUT', ref));
        return this.source.put(ref, data);
    }

    async delete(ref: string): Promise<void> {
        this.log.write(this.formatter('DELETE', ref));
        return this.source.delete(ref);
    }
}

/**
 * Example usage demonstrating the caching behavior.
 * This is analogous to the client compositions in Section 4.4.
 */
async function main() {
    // 1. Set up the stores and logger.
    const logger = { write: (message: string) => console.log(message) };

    const httpSource = new HttpStore('https://jsonplaceholder.typicode.com');
    const loggedHttpSource = new LoggingStore(
        httpSource,
        logger,
        (op, ref) => `[SOURCE] ${op} ${ref}`
    );

    const dictCache = new DictStore<string>();
    const loggedDictCache = new LoggingStore(
        dictCache,
        logger,
        (op, ref) => `[CACHE] ${op} ${ref}`
    );

    const store = new CachingStore(loggedHttpSource, loggedDictCache);

    const resourceRef = 'todos/1';

    // 2. First request for the resource.
    logger.write('--- First request (should be a cache miss) ---');
    let todo = await store.get(resourceRef);
    logger.write(`Data: ${todo}`);
    logger.write('');

    // 3. Second request for the same resource.
    logger.write('--- Second request (should be a cache hit) ---');
    todo = await store.get(resourceRef);
    logger.write(`Data: ${todo}`);
    logger.write('');

    // 4. Clean up the cache.
    logger.write('--- Cleaning up cache ---');
    // In a real app, you might not delete from the source.
    // We use the CachingStore's delete which would try both.
    await dictCache.delete(resourceRef);
    logger.write(`Cache for '${resourceRef}' cleaned.`);
}

main().catch(console.error);
