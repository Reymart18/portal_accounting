import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Admin } from './admin.entity';
import { AdminActivity } from './admin-activity.entity';
import { MemberInvitationBatch } from './member-invitation-batch.entity';
import { PropertyAccount } from '../property/property.entity';
import { PropertyService } from '../property/property.service';
import { FoxproBilling } from '../foxpro/foxpro-billing.entity';
import { FoxproPayment } from '../foxpro/foxpro-payment.entity';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

@Injectable()
export class AdminService {
    constructor(
        @InjectRepository(Admin)
        private adminRepo: Repository<Admin>,
        @InjectRepository(AdminActivity)
        private activityRepo: Repository<AdminActivity>,
        @InjectRepository(MemberInvitationBatch)
        private invitationBatchRepo: Repository<MemberInvitationBatch>,
        @InjectRepository(PropertyAccount)
        private propertyRepo: Repository<PropertyAccount>,
        @InjectRepository(FoxproBilling)
        private billingRepo: Repository<FoxproBilling>,
        @InjectRepository(FoxproPayment)
        private paymentRepo: Repository<FoxproPayment>,
        private propertyService: PropertyService,
        private dataSource: DataSource,
    ) { }

    async logActivity(input: {
        actorId?: number;
        actorUsername?: string;
        action: string;
        targetType?: string | null;
        targetId?: string | null;
        details?: string | null;
    }): Promise<AdminActivity | null> {
        // Skip logging for bulk uploads and sync operations per request
        const ignoredActions = new Set([
            'upload_billings',
            'upload_payments',
            'sync_payments_dbf',
            'sync_billings_dbf',
            'sync_members_dbf',
        ]);

        if (ignoredActions.has(input.action)) {
            return null;
        }

        const activity = this.activityRepo.create({
            actorId: input.actorId ?? null,
            actorUsername: input.actorUsername ?? null,
            action: input.action,
            targetType: input.targetType ?? null,
            targetId: input.targetId ?? null,
            details: input.details ?? null,
        });

        return this.activityRepo.save(activity);
    }

    async getRecentActivities(limit?: number, page?: number): Promise<{
        items: AdminActivity[];
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    }> {
        const resolvedLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit as number) : 6, 1), 50);
        const resolvedPage = Math.max(Number.isFinite(page) ? Math.floor(page as number) : 1, 1);
        const [items, total] = await this.activityRepo.findAndCount({
            order: { createdAt: 'DESC' },
            take: resolvedLimit,
            skip: (resolvedPage - 1) * resolvedLimit,
        });

        return {
            items,
            page: resolvedPage,
            limit: resolvedLimit,
            total,
            totalPages: Math.max(Math.ceil(total / resolvedLimit), 1),
        };
    }

    async createAdmin(username: string, password: string, fullName: string, role: string = 'admin'): Promise<Admin> {
        const hashedPassword = await bcrypt.hash(password, 10);
        const admin = this.adminRepo.create({
            username,
            password: hashedPassword,
            fullName,
            role,
            passwordChanged: false,
        });
        return this.adminRepo.save(admin);
    }

    async getAllAdmins(): Promise<Admin[]> {
        return this.adminRepo.find({ where: { hiddenFromPortal: false } });
    }

    async getAdminById(id: number): Promise<Admin | null> {
        return this.adminRepo.findOne({ where: { id } });
    }

    async deleteAdmin(id: number): Promise<{ deleted: boolean }> {
        const result = await this.adminRepo.delete({ id });
        if (!result.affected) {
            throw new NotFoundException('Admin not found');
        }

        return { deleted: true };
    }

    async resetAdminPassword(id: number, newPassword: string): Promise<Admin> {
        const admin = await this.adminRepo.findOne({ where: { id } });
        if (!admin) {
            throw new NotFoundException('Admin not found');
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        admin.password = hashedPassword;
        admin.passwordChanged = false;
        return this.adminRepo.save(admin);
    }

    async changePassword(id: number, oldPassword: string, newPassword: string): Promise<{ success: boolean }> {
        const admin = await this.adminRepo.findOne({ where: { id } });
        if (!admin || !admin.password) {
            throw new NotFoundException('Admin not found');
        }

        const passwordMatches = await bcrypt.compare(oldPassword, admin.password);
        if (!passwordMatches) {
            throw new UnauthorizedException('Current password is incorrect');
        }

        admin.password = await bcrypt.hash(newPassword, 10);
        admin.passwordChanged = true;
        await this.adminRepo.save(admin);

        return { success: true };
    }

    async getAllPropertyAccounts() {
        const members = await this.dataSource.query(`
            SELECT
                id,
                CONCAT(block_code, '-', lot_code) AS accountId,
                block_code AS block,
                lot_code AS lot,
                registered_owners AS memberName,
                sqm_size AS propertySizeSqm,
                classification,
                email AS gmail,
                cellphone_number AS celno,
                telephone_number AS telno,
                principal,
                interest,
                penalty,
                (principal + interest + penalty) AS balance
            FROM members
            ORDER BY CAST(block_code AS UNSIGNED), CAST(lot_code AS UNSIGNED), id
        `);

        return members.map((member: {
            id: number;
            accountId: string;
            block: string;
            lot: string;
            memberName: string | null;
            propertySizeSqm: number | null;
            classification: string;
            gmail: string | null;
            celno: string | null;
            telno: string | null;
            principal: number;
            interest: number;
            penalty: number;
            balance: number;
        }) => ({
            ...member,
            neighborhood: '',
            balance: Number(member.balance || 0),
            principal: Number(member.principal || 0),
            interest: Number(member.interest || 0),
            penalty: Number(member.penalty || 0),
            goodStandingStatus: Number(member.balance || 0) > 0
                ? 'Not in Good Standing'
                : 'In Good Standing',
        }));
    }

    async updatePropertyAccount(
        accountId: string,
        updates: Partial<PropertyAccount>,
    ): Promise<PropertyAccount> {
        const account = await this.propertyRepo.findOne({ where: { accountId } });
        if (!account) {
            throw new NotFoundException('Account not found');
        }

        const allowedFields: Array<keyof PropertyAccount> = [
            'memberName',
            'propertySizeSqm',
            'classification',
            'username',
            'gmail',
            'telno',
            'celno',
        ];

        for (const field of allowedFields) {
            if (updates[field] === undefined) {
                continue;
            }

            if (field === 'propertySizeSqm') {
                const numericValue = Number(updates[field]);
                if (Number.isNaN(numericValue)) {
                    throw new BadRequestException(`Invalid ${field}`);
                }
                account[field] = numericValue as any;
                continue;
            }

            account[field] = updates[field] as any;
        }

        return this.propertyRepo.save(account);
    }

    async deletePropertyAccount(accountId: string): Promise<{ deleted: boolean }> {
        const result = await this.propertyRepo.delete({ accountId });
        if (!result.affected) {
            throw new NotFoundException('Account not found');
        }

        return { deleted: true };
    }

    async resetPropertyAccountPassword(accountId: string): Promise<{ success: boolean; emailedTo: string }> {
        const account = await this.propertyRepo.findOne({ where: { accountId } });
        if (!account) {
            throw new NotFoundException('Account not found');
        }

        if (!account.gmail) {
            throw new BadRequestException('Gmail is not set for this account. Sync or update the member Gmail first.');
        }

        const temporaryPassword = randomBytes(6).toString('hex');
        const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
        try {
            await this.sendResetCredentialsEmail({
                accountId: account.accountId || accountId,
                memberName: account.memberName || 'Member',
                gmail: account.gmail,
                temporaryPassword,
            });
        } catch (err) {
            console.error('Reset member password email error:', err);
            throw new BadRequestException('Password reset was cancelled because the credentials email could not be sent.');
        }

        account.password = hashedPassword;
        account.passwordChanged = false;
        account.portalAccessEnabled = true;
        account.invitationStatus = 'sent';
        account.invitationAttemptedAt = new Date();
        account.invitationSentAt = new Date();
        account.invitationError = null;
        account.invitationBatchId = null;
        await this.propertyRepo.save(account);

        return { success: true, emailedTo: account.gmail };
    }

    async getInvitationSummary() {
        const rows = await this.propertyRepo
            .createQueryBuilder('account')
            .select('account.invitation_status', 'status')
            .addSelect('COUNT(*)', 'count')
            .groupBy('account.invitation_status')
            .getRawMany<{ status: string; count: string }>();
        const countByStatus = new Map(rows.map((row) => [row.status, Number(row.count || 0)]));
        const [gmailMissing, active, latestBatches] = await Promise.all([
            this.propertyRepo.createQueryBuilder('account')
                .where("account.gmail IS NULL OR TRIM(account.gmail) = ''")
                .getCount(),
            this.propertyRepo.count({ where: { portalAccessEnabled: true } }),
            this.invitationBatchRepo.find({ order: { id: 'DESC' }, take: 1 }),
        ]);
        const latestBatch = latestBatches[0] || null;

        return {
            pending: countByStatus.get('pending') || 0,
            processing: countByStatus.get('processing') || 0,
            sent: countByStatus.get('sent') || 0,
            failed: countByStatus.get('failed') || 0,
            gmailMissing,
            portalActive: active,
            latestBatch: latestBatch ? this.toInvitationBatchResult(latestBatch) : null,
        };
    }

    async createNextInvitationBatch(requestedBy: string, batchSize = 50) {
        return this.createInvitationBatch(requestedBy, batchSize, 'pending');
    }

    async createFailedInvitationBatch(requestedBy: string, batchSize = 100) {
        return this.createInvitationBatch(requestedBy, batchSize, 'failed');
    }

    private async createInvitationBatch(
        requestedBy: string,
        batchSize: number,
        invitationStatus: 'pending' | 'failed',
    ) {
        const resolvedSize = Math.min(Math.max(Math.floor(Number(batchSize) || 50), 1), 100);
        const batch = await this.dataSource.transaction(async (manager) => {
            const batchRepo = manager.getRepository(MemberInvitationBatch);
            const accountRepo = manager.getRepository(PropertyAccount);
            const activeBatch = await batchRepo.findOne({
                where: { status: In(['pending', 'processing']) },
                order: { id: 'DESC' },
            });
            if (activeBatch) {
                throw new BadRequestException('An invitation batch is already running. Wait for it to finish before starting another batch.');
            }

            const accounts = await accountRepo
                .createQueryBuilder('account')
                .setLock('pessimistic_write')
                .where('account.invitation_status = :status', { status: invitationStatus })
                .setParameter('status', invitationStatus)
                .andWhere('account.portal_access_enabled = :access', { access: false })
                .andWhere("account.gmail IS NOT NULL AND TRIM(account.gmail) <> ''")
                .orderBy('account.accountId', 'ASC')
                .take(resolvedSize)
                .getMany();

            if (!accounts.length) {
                throw new BadRequestException('No members are ready to invite.');
            }

            const created = await batchRepo.save(batchRepo.create({
                status: 'pending',
                requestedBy,
                requestedCount: accounts.length,
                sentCount: 0,
                failedCount: 0,
            }));
            for (const account of accounts) {
                account.invitationStatus = 'processing';
                account.invitationAttemptedAt = new Date();
                account.invitationError = null;
                account.invitationBatchId = created.id || null;
            }
            await accountRepo.save(accounts);
            return created;
        });

        setImmediate(() => {
            void this.processInvitationBatch(batch.id || 0);
        });
        return this.toInvitationBatchResult(batch);
    }

    async getInvitationBatch(id: number) {
        const batch = await this.invitationBatchRepo.findOne({ where: { id } });
        if (!batch) {
            throw new NotFoundException('Invitation batch not found.');
        }
        return this.toInvitationBatchResult(batch);
    }

    private async processInvitationBatch(batchId: number) {
        const batch = await this.invitationBatchRepo.findOne({ where: { id: batchId } });
        if (!batch || batch.status === 'completed') return;

        batch.status = 'processing';
        batch.startedAt = new Date();
        await this.invitationBatchRepo.save(batch);

        const accounts = await this.propertyRepo.find({
            where: { invitationBatchId: batchId, invitationStatus: 'processing' },
            order: { accountId: 'ASC' },
        });
        const invitationIntervalMs = 10_000;
        let lastInvitationAttemptAt = 0;

        for (const account of accounts) {
            const gmail = account.gmail?.trim();
            if (!gmail) {
                account.portalAccessEnabled = false;
                account.invitationStatus = 'not_eligible';
                account.invitationError = 'Gmail is not set for this account.';
                account.invitationBatchId = null;
                await this.propertyRepo.save(account);
                batch.failedCount = Number(batch.failedCount || 0) + 1;
                await this.invitationBatchRepo.save(batch);
                continue;
            }

            const temporaryPassword = randomBytes(6).toString('hex');
            try {
                const elapsedSinceLastAttempt = Date.now() - lastInvitationAttemptAt;
                const waitMs = Math.max(0, invitationIntervalMs - elapsedSinceLastAttempt);
                if (lastInvitationAttemptAt > 0 && waitMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                }
                lastInvitationAttemptAt = Date.now();
                await this.sendInvitationCredentialsEmail({
                    accountId: account.accountId || '',
                    memberName: account.memberName || 'Member',
                    gmail,
                    temporaryPassword,
                });
                account.password = await bcrypt.hash(temporaryPassword, 10);
                account.passwordChanged = false;
                account.portalAccessEnabled = true;
                account.invitationStatus = 'sent';
                account.invitationSentAt = new Date();
                account.invitationError = null;
                account.invitationBatchId = null;
                await this.propertyRepo.save(account);
                batch.sentCount = Number(batch.sentCount || 0) + 1;
            } catch (error) {
                account.portalAccessEnabled = false;
                account.invitationStatus = 'failed';
                account.invitationError = this.getInvitationError(error);
                account.invitationBatchId = null;
                await this.propertyRepo.save(account);
                batch.failedCount = Number(batch.failedCount || 0) + 1;
                console.error(`Member invitation email error for ${account.accountId}:`, error);
            }
            await this.invitationBatchRepo.save(batch);
        }

        batch.status = 'completed';
        batch.completedAt = new Date();
        await this.invitationBatchRepo.save(batch);
    }

    private toInvitationBatchResult(batch: MemberInvitationBatch) {
        return {
            id: batch.id,
            status: batch.status,
            requestedCount: Number(batch.requestedCount || 0),
            sentCount: Number(batch.sentCount || 0),
            failedCount: Number(batch.failedCount || 0),
            startedAt: batch.startedAt || null,
            completedAt: batch.completedAt || null,
        };
    }

    private getInvitationError(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        return message.slice(0, 1000) || 'Invitation email could not be sent.';
    }

    private getMailer() {
        const host = process.env.SMTP_HOST || 'smtp.gmail.com';
        const port = Number(process.env.SMTP_PORT || 465);
        const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
        const user = process.env.SMTP_USER || '';
        const pass = process.env.SMTP_PASS || '';

        if (!user || !pass) {
            throw new BadRequestException('Email service is not configured.');
        }

        const options: SMTPTransport.Options & { family?: number } = {
            host,
            port,
            secure,
            auth: { user, pass },
        };
        if (process.env.SMTP_REQUIRE_TLS === 'true') options.requireTLS = true;
        if (process.env.SMTP_FORCE_IPV4 === 'true') options.family = 4;
        return nodemailer.createTransport(options);
    }

    private async sendResetCredentialsEmail(credentials: {
        accountId: string;
        memberName: string;
        gmail: string;
        temporaryPassword: string;
    }) {
        const transporter = this.getMailer();
        const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';

        await transporter.sendMail({
            from,
            to: credentials.gmail,
            subject: 'Your HOA Portal Password Has Been Reset',
            text: [
                `Hello ${credentials.memberName},`,
                '',
                'Your HOA Portal password has been reset by the HOA office.',
                '',
                `Portal link: ${this.getPortalUrl()}`,
                `Username / Account ID: ${credentials.accountId}`,
                `Temporary password: ${credentials.temporaryPassword}`,
                '',
                'Please log in and change your password immediately.',
            ].join('\n'),
            html: this.buildCredentialsEmailHtml(
                credentials,
                'Your HOA Portal password has been reset by the HOA office.',
            ),
        });
    }

    private async sendInvitationCredentialsEmail(credentials: {
        accountId: string;
        memberName: string;
        gmail: string;
        temporaryPassword: string;
    }) {
        const transporter = this.getMailer();
        const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';

        await transporter.sendMail({
            from,
            to: credentials.gmail,
            subject: 'Your HOA Portal Account Credentials',
            text: [
                `Hello ${credentials.memberName},`,
                '',
                'Your HOA Portal account is ready to use.',
                '',
                `Portal link: ${this.getPortalUrl()}`,
                `Username / Account ID: ${credentials.accountId}`,
                `Temporary password: ${credentials.temporaryPassword}`,
                '',
                'Please log in and change your password immediately.',
            ].join('\n'),
            html: this.buildCredentialsEmailHtml(
                credentials,
                'Your HOA Portal account is ready to use.',
            ),
        });
    }

    private buildCredentialsEmailHtml(
        credentials: { accountId: string; memberName: string; temporaryPassword: string },
        message: string,
    ): string {
        const escape = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;',
        }[character] || character));
        const portalUrl = this.getPortalUrl();

        return `<!doctype html>
<html><body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;color:#1e293b">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <tr><td align="center" style="padding:26px 24px 18px;background:#fff7ed"><img src="${escape(`${portalUrl}/pvhai.png`)}" alt="Parkplace Village Homeowners Association" width="96" style="display:block;max-width:96px;height:auto"></td></tr>
      <tr><td style="padding:28px 32px">
        <p style="margin:0 0 18px;font-size:16px">Hello ${escape(credentials.memberName || 'Member')},</p>
        <p style="margin:0 0 22px;font-size:16px;line-height:24px">${escape(message)}</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 22px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px"><tr><td style="padding:16px;font-size:14px;line-height:23px">
          <strong>Portal link:</strong> <a href="${escape(portalUrl)}" style="color:#8c4100">${escape(portalUrl)}</a><br>
          <strong>Username / Account ID:</strong> ${escape(credentials.accountId)}<br>
          <strong>Temporary password:</strong> ${escape(credentials.temporaryPassword)}
        </td></tr></table>
        <p style="margin:0;font-size:14px;line-height:22px;color:#475569">Please log in and change your password immediately.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
    }

    private getPortalUrl(): string {
        const configured = process.env.PORTAL_URL || process.env.FRONTEND_URL;
        if (configured?.trim()) {
            return configured.trim().replace(/\/+$/, '');
        }

        return 'https://parkplacevillage.cloud';
    }

    private formatBillingMonthStart(billingMonth: string): string {
        const [year, month] = billingMonth.split('-').map(Number);
        return `${month}/1/${year}`;
    }

    private formatBillingMonthEnd(billingMonth: string): string {
        const [year, month] = billingMonth.split('-').map(Number);
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return `${month}/${lastDay}/${year}`;
    }

    async getDashboardSummary(): Promise<{
        currentBillingLabel: string;
        unpaidAccountsCount: number;
        overpaidAccountsCount: number;
        settledAccountsCount: number;
        notGoodStandingCount: number;
        totalCollectedPayments: number;
    }> {
        const [summary] = await this.dataSource.query(`
            SELECT
                latest.latest_month AS latest_month,
                COUNT(DISTINCT CASE
                    WHEN (m.principal + m.interest + m.penalty) > 0 THEN m.id
                END) AS unpaid_accounts,
                COUNT(DISTINCT CASE
                    WHEN (m.principal + m.interest + m.penalty) < 0 THEN m.id
                END) AS overpaid_accounts,
                COUNT(DISTINCT CASE
                    WHEN (m.principal + m.interest + m.penalty) = 0 THEN m.id
                END) AS settled_accounts,
                COALESCE(SUM(CASE
                    WHEN c.collection_date >= STR_TO_DATE(CONCAT(latest.latest_month, '-01'), '%Y-%m-%d')
                     AND c.collection_date <= LAST_DAY(STR_TO_DATE(CONCAT(latest.latest_month, '-01'), '%Y-%m-%d'))
                    THEN COALESCE(NULLIF(c.net_amount, 0), c.amount)
                    ELSE 0
                END), 0) AS total_collected_payments
            FROM members m
            LEFT JOIN collections c ON c.member_id = m.id
            CROSS JOIN (
                SELECT MAX(billing_month) AS latest_month
                FROM billings
            ) latest
            GROUP BY latest.latest_month
        `);

        const [overdue] = await this.dataSource.query(`
            SELECT COUNT(*) AS not_good_standing
            FROM members m
            WHERE (
                SELECT COUNT(DISTINCT billing_month)
                FROM billings b
                WHERE b.member_id = m.id
                  AND b.billing_month < (
                      SELECT MAX(billing_month) FROM billings
                  )
                  AND b.amount > 0
            ) >= 12
            AND (m.principal + m.interest + m.penalty) > 0
        `);

        const latestMonth = summary?.latest_month || null;
        const currentBillingLabel = latestMonth
            ? `${this.formatBillingMonthStart(latestMonth)} - ${this.formatBillingMonthEnd(latestMonth)}`
            : '-';

        return {
            currentBillingLabel,
            unpaidAccountsCount: Number(summary?.unpaid_accounts || 0),
            overpaidAccountsCount: Number(summary?.overpaid_accounts || 0),
            settledAccountsCount: Number(summary?.settled_accounts || 0),
            notGoodStandingCount: Number(overdue?.not_good_standing || 0),
            totalCollectedPayments: Number(summary?.total_collected_payments || 0),
        };
    }

    async getPaymentsCollectionReport(): Promise<any> {
        const [latest] = await this.dataSource.query(
            'SELECT MAX(billing_month) AS latest_month FROM billings',
        );
        const latestMonth = latest?.latest_month || null;
        if (!latestMonth) {
            return { currentBillingLabel: '-', billingStartKey: null, billingEndKey: null, items: [] };
        }

        const rows = await this.dataSource.query(
                        `SELECT COALESCE(NULLIF(TRIM(payment_method), ''), NULLIF(TRIM(payment_type), ''), 'Uncategorized') AS paycat,
                    COUNT(*) AS count,
                    COALESCE(SUM(COALESCE(NULLIF(net_amount, 0), amount)), 0) AS total
             FROM collections
             WHERE collection_date >= STR_TO_DATE(CONCAT(?, '-01'), '%Y-%m-%d')
               AND collection_date <= LAST_DAY(STR_TO_DATE(CONCAT(?, '-01'), '%Y-%m-%d'))
             GROUP BY paycat
             ORDER BY total DESC`,
            [latestMonth, latestMonth],
        );

        return {
            currentBillingLabel: `${this.formatBillingMonthStart(latestMonth)} - ${this.formatBillingMonthEnd(latestMonth)}`,
            billingStartKey: `${latestMonth}-01`,
            billingEndKey: `${latestMonth}-${this.formatBillingMonthEnd(latestMonth).split('/')[1]}`,
            items: rows.map((row: Record<string, unknown>) => ({
                paycat: String(row.paycat || 'Uncategorized'),
                count: Number(row.count || 0),
                total: Number(row.total || 0),
            })),
        };
    }

    async getPaymentsByCategoryReport(paycat: string): Promise<any> {
        const normalizedPaycat = String(paycat || '').trim();
        if (!normalizedPaycat) {
            throw new BadRequestException('Pay category is required');
        }

        const [latest] = await this.dataSource.query(
            'SELECT MAX(billing_month) AS latest_month FROM billings',
        );
        const latestMonth = latest?.latest_month || null;
        if (!latestMonth) {
            return { currentBillingLabel: '-', billingStartKey: null, billingEndKey: null, paycat: normalizedPaycat, items: [] };
        }

        const rows = await this.dataSource.query(`
            SELECT CONCAT(m.block_code, '-', m.lot_code) AS accountId,
                   m.registered_owners AS memberName,
                   c.collection_date AS paymentDate,
                   COALESCE(NULLIF(c.net_amount, 0), c.amount) AS amountPaid,
                   c.remarks AS description,
                   c.reference_number AS referenceNumber,
                   COALESCE(NULLIF(TRIM(c.payment_method), ''), NULLIF(TRIM(c.payment_type), ''), 'Uncategorized') AS paycat
            FROM collections c
            INNER JOIN members m ON m.id = c.member_id
            WHERE c.collection_date >= STR_TO_DATE(CONCAT(?, '-01'), '%Y-%m-%d')
              AND c.collection_date <= LAST_DAY(STR_TO_DATE(CONCAT(?, '-01'), '%Y-%m-%d'))
              AND COALESCE(NULLIF(TRIM(c.payment_method), ''), NULLIF(TRIM(c.payment_type), ''), 'Uncategorized') = ?
            ORDER BY c.collection_date DESC, c.id DESC`,
            [latestMonth, latestMonth, normalizedPaycat],
        );

        return {
            currentBillingLabel: `${this.formatBillingMonthStart(latestMonth)} - ${this.formatBillingMonthEnd(latestMonth)}`,
            billingStartKey: `${latestMonth}-01`,
            billingEndKey: `${latestMonth}-${this.formatBillingMonthEnd(latestMonth).split('/')[1]}`,
            paycat: normalizedPaycat,
            items: rows.map((row: Record<string, unknown>) => ({
                ...row,
                amountPaid: Number(row.amountPaid || 0),
            })),
        };
    }

    private async getAccountingMemberReport(
        reportType: 'settled' | 'overpaid' | 'unpaid' | 'not_good_standing',
    ) {
        const condition = {
            settled: '(m.principal + m.interest + m.penalty) = 0',
            overpaid: '(m.principal + m.interest + m.penalty) < 0',
            unpaid: '(m.principal + m.interest + m.penalty) > 0',
            not_good_standing: `(
                SELECT COUNT(DISTINCT overdue.billing_month)
                FROM billings overdue
                WHERE overdue.member_id = m.id
                  AND overdue.billing_month < latest.latest_month
                  AND overdue.amount > 0
            ) >= 12 AND (m.principal + m.interest + m.penalty) > 0`,
        }[reportType];

        const rows = await this.dataSource.query(`
            SELECT
                CONCAT(m.block_code, '-', m.lot_code) AS accountId,
                m.registered_owners AS memberName,
                m.classification,
                '' AS neighborhood,
                m.block_code AS block,
                m.lot_code AS lot,
                m.email AS gmail,
                m.telephone_number AS telno,
                m.cellphone_number AS celno,
                (m.principal + m.interest + m.penalty) AS amountDue,
                (
                    SELECT MAX(c.collection_date)
                    FROM collections c
                    WHERE c.member_id = m.id
                ) AS lastPaymentDate,
                latest.latest_month
            FROM members m
            CROSS JOIN (
                SELECT MAX(billing_month) AS latest_month
                FROM billings
            ) latest
            WHERE ${condition}
            ORDER BY CAST(m.block_code AS UNSIGNED), CAST(m.lot_code AS UNSIGNED), m.id
        `);

        const latestMonth = rows[0]?.latest_month || (
            await this.dataSource.query('SELECT MAX(billing_month) AS latest_month FROM billings')
        )[0]?.latest_month || null;

        return {
            currentBillingLabel: latestMonth
                ? `${this.formatBillingMonthStart(latestMonth)} - ${this.formatBillingMonthEnd(latestMonth)}`
                : '-',
            billingEndDateKey: latestMonth
                ? `${latestMonth}-${this.formatBillingMonthEnd(latestMonth).split('/')[1]}`
                : null,
            items: rows.map((row: Record<string, unknown>) => ({
                ...row,
                amountDue: Number(row.amountDue || 0),
            })),
        };
    }

    async getSettledAccountsReport(): Promise<{
        currentBillingLabel: string;
        billingEndDateKey: string | null;
        items: Array<Record<string, unknown>>;
    }> {
        return this.getAccountingMemberReport('settled');
    }

    async getOverpaidAccountsReport(): Promise<{
        currentBillingLabel: string;
        billingEndDateKey: string | null;
        items: Array<Record<string, unknown>>;
    }> {
        return this.getAccountingMemberReport('overpaid');
    }

    async getUnpaidAccountsReport(): Promise<{
        currentBillingLabel: string;
        billingEndDateKey: string | null;
        items: Array<Record<string, unknown>>;
    }> {
        return this.getAccountingMemberReport('unpaid');
    }

    async getNotGoodStandingReport(status?: string): Promise<{
        currentBillingLabel: string;
        billingEndDateKey: string | null;
        items: Array<Record<string, unknown>>;
    }> {
        return this.getAccountingMemberReport(status === 'good' ? 'settled' : 'not_good_standing');
    }
}
