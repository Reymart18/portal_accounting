import { ForbiddenException } from '@nestjs/common';

export type SyncMode = 'local_dbf' | 'push_api';

export function getSyncMode(): SyncMode {
    const configured = String(process.env.SYNC_MODE || '').trim().toLowerCase();
    if (configured === 'local_dbf' || configured === 'push_api') {
        return configured;
    }

    return 'push_api';
}

export function isLocalDbfMode(): boolean {
    return getSyncMode() === 'local_dbf';
}

export function assertLocalDbfMode() {
    if (!isLocalDbfMode()) {
        throw new ForbiddenException('Direct DBF access is disabled unless SYNC_MODE=local_dbf.');
    }
}
