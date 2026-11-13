import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface StatementRow {
    date: string;
    type: 'billing' | 'payment';
    dateFrom?: string | null;
    dateTo?: string | null;
    billDate?: string | null;
    BILLDATE?: string | null;
    dueDate?: string | null;
    referenceNumber?: string | null;
    paycat?: string | null;
    prinBal?: number;
    intBal?: number;
    penBal?: number;
    prinCurr?: number;
    intCurr?: number;
    penCurr?: number;
    duesRate?: number;
    previousBalance: number;
    amountDue: number;
    interest: number;
    penalty: number;
    amountPaid: number;
    totalBalance: number;
    description: string;
    isOnlinePayment?: boolean;
    paymentStatus?: string | null;
}

@Injectable()
export class StatementsService {
    constructor(
        private dataSource: DataSource,
    ) { }

    async getStatement(accountId: string): Promise<StatementRow[]> {
        const [blockCode, lotCode] = accountId.split('-');
        if (!blockCode || !lotCode) {
            return [];
        }

        const members = await this.dataSource.query(
            'SELECT id FROM members WHERE block_code = ? AND lot_code = ? LIMIT 1',
            [blockCode, lotCode],
        );
        if (members.length === 0) {
            return [];
        }

        const memberId = members[0].id;
        const [billings, payments] = await Promise.all([
            this.dataSource.query(
                `SELECT billing_month, rate, amount, created_at, principal, interest,
                        penalty, previous_principal, previous_interest, previous_penalty
                 FROM billings
                 WHERE member_id = ?
                 ORDER BY billing_month ASC, id ASC`,
                [memberId],
            ),
            this.dataSource.query(
                `SELECT collection_date, reference_number, amount, remarks, payment_type,
                        payment_method, net_amount, applied_penalty, applied_interest,
                        applied_principal
                 FROM collections
                 WHERE member_id = ?
                 ORDER BY collection_date ASC, id ASC`,
                [memberId],
            ),
        ]);

        const rows: Array<{
            dateValue: Date;
            type: 'billing' | 'payment';
            dateFromValue?: Date | null;
            dateToValue?: Date | null;
            billDateValue?: Date | null;
            dueDateValue?: Date | null;
            referenceNumber?: string | null;
            paycat?: string | null;
            prinBal?: number;
            intBal?: number;
            penBal?: number;
            previousBalance?: number;
            prinCurr?: number;
            intCurr?: number;
            penCurr?: number;
            duesRate?: number;
            amountDue: number;
            interest: number;
            penalty: number;
            amountPaid: number;
            description: string;
            isOnlinePayment?: boolean;
            paymentStatus?: string | null;
        }> = [];

        for (const billing of billings) {
            if (!billing.billing_month) {
                continue;
            }
            const monthStart = new Date(`${billing.billing_month}-01T00:00:00.000Z`);
            const dateFromValue = this.toDate(monthStart);
            const monthEnd = new Date(Date.UTC(
                monthStart.getUTCFullYear(),
                monthStart.getUTCMonth() + 1,
                0,
                23,
                59,
                59,
                999,
            ));
            const dateToValue = this.toDate(new Date(Date.UTC(
                monthStart.getUTCFullYear(),
                monthStart.getUTCMonth() + 1,
                0,
                12,
            )));
            const billDateValue = this.toDate(billing.created_at);
            const dueDateValue = this.toDate(monthEnd);
            rows.push({
                dateValue: dueDateValue || monthStart,
                type: 'billing',
                dateFromValue,
                dateToValue,
                billDateValue,
                dueDateValue,
                prinBal: Number(billing.previous_principal || 0),
                intBal: Number(billing.previous_interest || 0),
                penBal: Number(billing.previous_penalty || 0),
                previousBalance:
                    Number(billing.previous_principal || 0) +
                    Number(billing.previous_interest || 0) +
                    Number(billing.previous_penalty || 0),
                prinCurr: Number(billing.principal || 0),
                intCurr: Number(billing.interest || 0),
                penCurr: Number(billing.penalty || 0),
                duesRate: Number(billing.rate || 0),
                amountDue: Number(billing.principal || 0),
                interest: Number(billing.interest || 0),
                penalty: Number(billing.penalty || 0),
                amountPaid: 0,
                description: `Billing ${billing.billing_month}`,
            });
        }

        for (const payment of payments) {
            if (!payment.collection_date) {
                continue;
            }
            rows.push({
                dateValue: new Date(payment.collection_date),
                type: 'payment',
                referenceNumber: payment.reference_number ?? null,
                paycat: payment.payment_method ?? payment.payment_type ?? null,
                amountDue: 0,
                interest: 0,
                penalty: 0,
                amountPaid: Number(payment.net_amount || payment.amount || 0),
                description: payment.remarks || payment.payment_method || 'Payment',
                isOnlinePayment: false,
                paymentStatus: null,
            });
        }

        rows.sort((a, b) => a.dateValue.getTime() - b.dateValue.getTime());

        const statement: StatementRow[] = [];
        let runningBalance = 0;

        for (const row of rows) {
            const previousBalance =
                row.type === 'billing' && row.previousBalance !== undefined
                    ? row.previousBalance
                    : runningBalance;
            const amountPaidForBalance = row.isOnlinePayment ? 0 : row.amountPaid;
            const totalBalance =
                previousBalance + row.amountDue + row.interest + row.penalty - amountPaidForBalance;
            runningBalance = totalBalance;

            statement.push({
                date: row.dateValue.toISOString(),
                type: row.type,
                dateFrom: row.dateFromValue ? row.dateFromValue.toISOString() : null,
                dateTo: row.dateToValue ? row.dateToValue.toISOString() : null,
                billDate:
                    row.type === 'billing' && row.billDateValue
                        ? row.billDateValue.toISOString()
                        : null,
                BILLDATE:
                    row.type === 'billing' && row.billDateValue
                        ? row.billDateValue.toISOString()
                        : null,
                dueDate:
                    row.type === 'billing' && row.dueDateValue
                        ? row.dueDateValue.toISOString()
                        : null,
                referenceNumber: row.referenceNumber ?? null,
                paycat: row.paycat ?? null,
                prinBal: row.type === 'billing' ? row.prinBal ?? 0 : 0,
                intBal: row.type === 'billing' ? row.intBal ?? 0 : 0,
                penBal: row.type === 'billing' ? row.penBal ?? 0 : 0,
                prinCurr: row.type === 'billing' ? row.prinCurr ?? 0 : 0,
                intCurr: row.type === 'billing' ? row.intCurr ?? 0 : 0,
                penCurr: row.type === 'billing' ? row.penCurr ?? 0 : 0,
                duesRate: row.type === 'billing' ? row.duesRate ?? 0 : 0,
                previousBalance,
                amountDue: row.amountDue,
                interest: row.interest,
                penalty: row.penalty,
                amountPaid: row.amountPaid,
                totalBalance,
                description: row.description,
                isOnlinePayment: row.isOnlinePayment || false,
                paymentStatus: row.paymentStatus || null,
            });
        }

        return statement;
    }

    private toDate(value: Date | string | null | undefined): Date | null {
        if (!value) {
            return null;
        }

        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : value;
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }

        return parsed;
    }

    private formatDate(value: Date): string {
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

}
