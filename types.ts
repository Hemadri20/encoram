
export interface EncryptedFragment {
  timestamp: string;
  cipher: string;
  id: string;
}

export enum NodeTab {
  TEXT = 'txt',
  SKETCH = 'sk'
}

export interface NodeStatus {
  online: boolean;
  ip: string;
  clock: string;
  traffic: string;
  fragments: number;
}
