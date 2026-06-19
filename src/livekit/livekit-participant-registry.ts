const USER_IDENTITY_PREFIX = "user-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userIdFromParticipantIdentity(identity: string): string | undefined {
  if (!identity.startsWith(USER_IDENTITY_PREFIX)) {
    return undefined;
  }
  const userId = identity.slice(USER_IDENTITY_PREFIX.length);
  return UUID_PATTERN.test(userId) ? userId.toLowerCase() : undefined;
}

export class LiveKitParticipantRegistry {
  private readonly identityByUserId = new Map<string, string>();

  add(identity: string): boolean {
    const userId = userIdFromParticipantIdentity(identity);
    if (!userId) {
      return false;
    }
    this.identityByUserId.set(userId, identity);
    return true;
  }

  remove(identity: string): void {
    const userId = userIdFromParticipantIdentity(identity);
    if (userId && this.identityByUserId.get(userId) === identity) {
      this.identityByUserId.delete(userId);
    }
  }

  snapshotUserIds(): string[] {
    return [...this.identityByUserId.keys()].sort();
  }

  clear(): void {
    this.identityByUserId.clear();
  }
}
