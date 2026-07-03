export enum StagingState {
  DESIRED_STATE = "DESIRED_STATE",
  APPLIED_STATE = "APPLIED_STATE",
  DEPLOYED_STATE = "DEPLOYED_STATE",
  FAILED = "FAILED",
}

export interface StagingPipelineContext {
  serviceUuid: string;
  desiredDomain: string;
}

export interface StagingPipelineResult {
  success: boolean;
  state: StagingState;
  error?: string;
}
