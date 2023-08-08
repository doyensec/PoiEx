import * as jose from 'jose';

export class IaCEncryption {
    private secret: Uint8Array | jose.KeyLike | null = null;

    constructor() {

    }

    async setKey(b64secret: string | null = null) {
        if (b64secret === null) {
            this.secret = await jose.generateSecret('HS256', {extractable: true});
            return;
        }
        this.secret = jose.base64url.decode(b64secret);
    }

    static async genKey(): Promise<string> {
        let secret = await jose.generateSecret('HS256', {extractable: true});
        let secretArr = (secret as any).export();
        console.log(secretArr);
        return jose.base64url.encode(secretArr);
    }

    async checkKey(token: string): Promise<string | null> {
        if (this.secret === null) {
            return null;
        }
        try {
            let payload: any = await this.decrypt(token);
            return payload.uuid;
        } catch (e) {
            return null;
        }
    }
    
    async encrypt(data: {}): Promise<string> {
        if (this.secret === null) {
            throw new Error("Encryption key not set");
        }
        const jwt = await new jose.EncryptJWT(data).setProtectedHeader({ alg: 'dir', enc: 'A128CBC-HS256' }).encrypt(this.secret);
        return jwt;
    }

    async decrypt(jwt: string): Promise<{}> {
        if (this.secret === null) {
            throw new Error("Encryption key not set");
        }
        const { payload, protectedHeader } = await jose.jwtDecrypt(jwt, this.secret);
        return payload;
    }

    async optionallyEncryptString(data: string | null): Promise<string | null> {
        if (this.secret === null) {
            return data;
        }
        if (data === null) { return null; }
        return await this.encrypt({"p": data});
    }

    async optionallyDecryptString(data: string | null): Promise<string | null> {
        if (this.secret === null) {
            return data;
        }
        if (data === null) { return null; }
        let payload: any = await this.decrypt(data);
        return payload.p;
    }

    async exportKey(): Promise<string> {
        if (this.secret === null) {
            throw new Error("Encryption key not set");
        }
        return jose.base64url.encode(this.secret as Uint8Array);
    }

    dispose() {
        this.secret = null;
    }
}