export interface SharedFile {
    name: string;
    path: string;
    source?: string;
}

export interface ParticipantState {
    myName: string;
    others: { [key: string]: string };
    roomName: string;
}

export interface P2PMessage {
    type: string;
    [key: string]: any;
}
