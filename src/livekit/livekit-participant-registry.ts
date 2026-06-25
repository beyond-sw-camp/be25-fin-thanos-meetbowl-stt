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

export interface ParticipantRegistrySyncSummary {
  roomParticipantCount: number;
  authenticatedParticipantCount: number;
  ignoredParticipantCount: number;
  addedCount: number;
  removedCount: number;
  replacedCount: number;
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

  replace(identities: Iterable<string>): ParticipantRegistrySyncSummary {
    const nextIdentityByUserId = new Map<string, string>();
    let roomParticipantCount = 0;
    let ignoredParticipantCount = 0;

    for (const identity of identities) {
      roomParticipantCount += 1;
      const userId = userIdFromParticipantIdentity(identity);
      if (!userId) {
        ignoredParticipantCount += 1;
        continue;
      }
      nextIdentityByUserId.set(userId, identity);
    }

    let addedCount = 0;
    let replacedCount = 0;
    for (const [userId, identity] of nextIdentityByUserId) {
      const previousIdentity = this.identityByUserId.get(userId);
      if (!previousIdentity) {
        addedCount += 1;
        continue;
      }
      if (previousIdentity !== identity) {
        replacedCount += 1;
      }
    }

    let removedCount = 0;
    for (const userId of this.identityByUserId.keys()) {
      if (!nextIdentityByUserId.has(userId)) {
        removedCount += 1;
      }
    }

    this.identityByUserId.clear();
    for (const [userId, identity] of nextIdentityByUserId) {
      this.identityByUserId.set(userId, identity);
    }

    return {
      roomParticipantCount,
      authenticatedParticipantCount: nextIdentityByUserId.size,
      ignoredParticipantCount,
      addedCount,
      removedCount,
      replacedCount
    };
  }

  identitiesForUserIds(userIds: readonly string[]): string[] {
    const identities = new Set<string>();
    for (const userId of userIds) {
      const identity = this.identityByUserId.get(userId.toLowerCase());
      if (identity) identities.add(identity);
    }
    return [...identities].sort();
  }

  clear(): void {
    this.identityByUserId.clear();
  }
}
