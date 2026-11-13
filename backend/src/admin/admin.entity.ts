import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity({ name: 'admin' })
export class Admin {
    @PrimaryGeneratedColumn()
    id?: number;

    @Column({ unique: true })
    username?: string;

    @Column()
    password?: string;

    @Column()
    fullName?: string;

    @Column({ default: 'admin' })
    role?: string;

    @Column({ default: true })
    passwordChanged?: boolean;

    @Column({ default: false })
    hiddenFromPortal?: boolean;
}
