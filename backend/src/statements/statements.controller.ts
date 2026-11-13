import {
    BadRequestException,
    Controller,
    ForbiddenException,
    Get,
    Param,
    Request,
    UseGuards,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { StatementsService, type StatementRow } from './statements.service';

interface AuthenticatedRequest extends ExpressRequest {
    user: {
        id: number;
        username: string;
        role: string;
    };
}

@Controller('statements')
export class StatementsController {
    constructor(
        private statementsService: StatementsService,
        private dataSource: DataSource,
    ) { }

    @UseGuards(JwtAuthGuard)
    @Get(':accountId')
    async getStatement(
        @Param('accountId') accountId: string,
        @Request() req: AuthenticatedRequest,
    ): Promise<StatementRow[]> {
        const [blockCode, lotCode] = accountId.split('-');
        const members = await this.dataSource.query(
            'SELECT id FROM members WHERE block_code = ? AND lot_code = ? LIMIT 1',
            [blockCode, lotCode],
        );
        if (members.length === 0) {
            throw new BadRequestException('Account not found');
        }

        if (req.user.role === 'homeowner' && Number(members[0].id) !== req.user.id) {
            throw new ForbiddenException('You can only access your own statement');
        }

        if (req.user.role !== 'homeowner' && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            throw new ForbiddenException('You are not allowed to access this resource');
        }

        return this.statementsService.getStatement(accountId);
    }
}
