// Papéis por instância (research R-27): tudo desligado, a não ser o que o teste pede.
export interface Roles {
  consumer?: boolean;
  publisher?: boolean;
  pendingWorker?: boolean;
}

export function roleEnv(roles: Roles = {}): Record<string, string> {
  return {
    CONSUMER_ENABLED: String(roles.consumer ?? false),
    PUBLISHER_ENABLED: String(roles.publisher ?? false),
    PENDING_WORKER_ENABLED: String(roles.pendingWorker ?? false),
  };
}
