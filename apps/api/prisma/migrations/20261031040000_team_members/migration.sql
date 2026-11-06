-- BIZ-04: team members (a person who works on another owner's workspace with their own login), their invitations, and who acted in the audit trail.
ALTER TABLE "AuditLog" ADD COLUMN "actorId" TEXT;
CREATE INDEX "AuditLog_userId_actorId_at_idx" ON "AuditLog"("userId", "actorId", "at");

CREATE TABLE "TeamMember" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "invitedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamMember_role_check" CHECK ("role" IN ('viewer', 'editor')),
  CONSTRAINT "TeamMember_not_self_check" CHECK ("workspaceId" <> "memberId")
);
CREATE UNIQUE INDEX "TeamMember_workspaceId_memberId_key" ON "TeamMember"("workspaceId", "memberId");
CREATE INDEX "TeamMember_memberId_idx" ON "TeamMember"("memberId");

CREATE TABLE "TeamInvite" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "emailCanonical" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "invitedBy" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamInvite_role_check" CHECK ("role" IN ('viewer', 'editor'))
);
CREATE UNIQUE INDEX "TeamInvite_tokenHash_key" ON "TeamInvite"("tokenHash");
CREATE INDEX "TeamInvite_workspaceId_idx" ON "TeamInvite"("workspaceId");
CREATE INDEX "TeamInvite_emailCanonical_idx" ON "TeamInvite"("emailCanonical");
