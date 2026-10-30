import type { McpToolAnnotations } from './tools.js';
import { denial, renderDenial } from './denial.js';
import { formatToolFailure, toToolFailure } from './errors.js';
import { TIER_LABEL, type Tier } from './tiers.js';
import type { McpToolEntry } from './facade.js';

export type AccountToolDef = {
  name: string;
  tier: Tier;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  /** Dashboard surfaces this tool replaces: `route:<METHOD> <path>` | `action:<name>` | `page:<path>`. */
  covers: readonly string[];
};

const s = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'string',
  description,
  ...extra,
});
const b = (description: string) => ({ type: 'boolean', description });
const n = (description: string) => ({ type: 'integer', description });
const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
/** Declared input fields of an operation or function; the names say enough, so no per-key prose. */
const INPUT_FIELDS = {
  type: 'array',
  items: obj(
    {
      name: { type: 'string' },
      type: { type: 'string', enum: ['string', 'number', 'boolean'] },
      required: { type: 'boolean' },
      description: { type: 'string' },
    },
    ['name'],
  ),
};
const CONFIRM = {
  confirmToken: s('From the CONFIRMATION_REQUIRED reply.'),
};

function annotationsFor(tier: Tier, idempotent = false): McpToolAnnotations {
  return {
    readOnlyHint: tier === 'read',
    destructiveHint: tier === 'destructive',
    idempotentHint: tier === 'read' || idempotent,
    openWorldHint: false,
  };
}

/** Tools about the person or this connection, not a workspace: they take no workspace argument. */
const USER_LEVEL_TOOLS: ReadonlySet<string> = new Set([
  'update_profile',
  'change_password',
  'register_push_token',
  'remove_push_token',
  'accept_invitation',
  'list_connections',
  'get_connect_links',
  'disconnect',
  'list_granted_scopes',
  'request_scopes',
]);

function withWorkspaceArg(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  if (USER_LEVEL_TOOLS.has(name)) return schema;
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...properties,
      organizationId: s('Approved workspace id only.'),
    },
  };
}

function def(
  name: string,
  tier: Tier,
  title: string,
  description: string,
  inputSchema: Record<string, unknown>,
  covers: readonly string[] = [],
  idempotent = false,
): AccountToolDef {
  return {
    name,
    tier,
    title,
    description,
    inputSchema: withWorkspaceArg(name, inputSchema),
    annotations: annotationsFor(tier, idempotent),
    covers,
  };
}

export const ACCOUNT_TOOL_DEFS: readonly AccountToolDef[] = [
  // billing
  def(
    'billing_status',
    'read',
    'Billing status',
    'Current plan, renewal date, trial, quota used and remaining.',
    obj(),
    ['page:/dashboard/billing'],
  ),
  def('list_plans', 'read', 'List plans', 'Plans with price, monthly quota and limits.', obj(), [
    'page:/dashboard/billing#plans',
  ]),
  def(
    'upgrade_plan',
    'billing',
    'Upgrade plan',
    'Returns a one-click checkout link for a plan. Ask the user which plan; never choose for them.',
    obj({ plan: s('Plan slug from list_plans') }, ['plan']),
    ['client:revenuecat-purchase'],
  ),
  def(
    'manage_subscription',
    'billing',
    'Manage subscription',
    'cancel (at period end), refund (last payment, revokes access) or open the billing portal. cancel and refund need a confirmToken.',
    obj({ action: s('Action', { enum: ['cancel', 'resume', 'refund', 'portal'] }), ...CONFIRM }, [
      'action',
    ]),
    ['client:revenuecat-portal'],
  ),
  // account
  def('get_profile', 'read', 'Get profile', 'Your name, email, workspace and role.', obj(), [
    'page:/dashboard/settings#profile',
  ]),
  def(
    'update_profile',
    'account',
    'Update profile',
    'Change your display name or avatar URL.',
    obj({ name: s('Display name'), avatarUrl: s('Avatar image URL') }),
    [],
    true,
  ),
  def(
    'update_workspace',
    'account',
    'Rename workspace',
    'Rename the workspace (admin or owner).',
    obj({ name: s('Workspace name, 2-60 characters') }, ['name']),
    ['action:updateOrgAction', 'action:updateWorkspaceName'],
    true,
  ),
  def(
    'change_password',
    'account',
    'Change password',
    'Set a new password. Accounts that already have one must also pass currentPassword.',
    obj(
      {
        newPassword: s('At least 8 characters'),
        currentPassword: s('Required if a password is already set'),
      },
      ['newPassword'],
    ),
    ['action:setAccountPassword'],
  ),
  def(
    'update_notification_prefs',
    'account',
    'Notification preferences',
    'Read or change in-app tips and prompts. Omit the field to just read.',
    obj({ tipsAndPromptsEnabled: b('Show tips and prompts') }),
    ['route:GET /api/user/preferences', 'route:PATCH /api/user/preferences'],
    true,
  ),
  def(
    'register_push_token',
    'account',
    'Register push token',
    'Register a device push token for notifications.',
    obj(
      {
        token: s('Device token'),
        provider: s('Provider', { enum: ['fcm', 'apns'] }),
        previousToken: s('Token being rotated out'),
      },
      ['token', 'provider'],
    ),
    ['route:POST /api/user/notifly-push-token'],
  ),
  def(
    'remove_push_token',
    'account',
    'Remove push token',
    'Unregister a device push token.',
    obj({ token: s('Device token'), provider: s('Provider', { enum: ['fcm', 'apns'] }) }, [
      'token',
      'provider',
    ]),
    ['route:DELETE /api/user/notifly-push-token'],
    true,
  ),
  def(
    'export_data',
    'account',
    'Export my data',
    'Profile, workspace, members, keys (prefixes only), BYO APIs, hosted functions, products and 90 days of call logs as JSON. Large exports return a download link.',
    obj(),
    [],
  ),
  def(
    'delete_account',
    'account',
    'Delete account',
    'Ask the user to confirm the workspace name before calling; never decide for them. Permanently closes the account and deletes the workspace, its keys, APIs, functions and data (support can restore from backups on request). Needs a confirmToken; owner only.',
    obj({ workspaceName: s('Exact workspace name, as a typo guard'), ...CONFIRM }, [
      'workspaceName',
    ]),
    ['action:deleteOrgAction'],
  ),
  def(
    'get_account_summary',
    'read',
    'Account summary',
    'Plan, role, usage and workspace summary.',
    obj(),
    ['route:GET /api/account/summary'],
  ),
  def(
    'get_usage',
    'read',
    'Usage and quota',
    'Monthly units used and remaining, per-minute limits, trial cap, compute and hosted-function usage, broken down by key and connected client.',
    obj(),
    ['route:GET /api/usage', 'page:/dashboard/analytics'],
  ),
  def(
    'list_call_logs',
    'read',
    'Call logs',
    'Recent operation calls with status, caller and cost.',
    obj({
      page: n('1-based page'),
      status: s('Filter', { enum: ['success', 'error'] }),
      operation: s('Operation slug'),
    }),
    ['page:/dashboard/logs'],
  ),
  def(
    'complete_onboarding',
    'account',
    'Complete onboarding',
    'Mark the welcome checklist done.',
    obj(),
    ['action:markOnboardingComplete', 'action:getOnboardingState'],
    true,
  ),
  // team
  def('list_members', 'read', 'List members', 'Workspace members and roles.', obj(), [
    'page:/dashboard/settings#team',
  ]),
  def('list_invites', 'read', 'List invites', 'Pending invitations.', obj(), [
    'page:/dashboard/settings#team-invites',
  ]),
  def(
    'invite_member',
    'team',
    'Invite member',
    'Ask the user who to invite and with which role; never choose for them. Emails an invitation (admin or owner).',
    obj({ email: s('Invitee email'), role: s('Role', { enum: ['member', 'admin'] }) }, ['email']),
    ['client:org.inviteMember'],
  ),
  def(
    'update_member_role',
    'team',
    'Change member role',
    'Change a member between member and admin.',
    obj({ userId: s('Member user id'), role: s('Role', { enum: ['member', 'admin'] }) }, [
      'userId',
      'role',
    ]),
    ['client:org.updateMemberRole'],
    true,
  ),
  def(
    'remove_member',
    'team',
    'Remove member',
    'Remove a member from the workspace. Needs a confirmToken.',
    obj({ userId: s('Member user id'), ...CONFIRM }, ['userId']),
    ['client:org.removeMember'],
  ),
  def(
    'revoke_invite',
    'team',
    'Revoke invite',
    'Cancel a pending invitation.',
    obj({ invitationId: s('Invitation id') }, ['invitationId']),
    ['client:org.cancelInvitation'],
    true,
  ),
  def(
    'accept_invitation',
    'team',
    'Accept invitation',
    'Accept an invitation addressed to your email.',
    obj({ invitationId: s('Invitation id') }, ['invitationId']),
    ['page:/accept-invitation/[id]'],
  ),
  // support
  def(
    'create_support_ticket',
    'support',
    'Contact support',
    'Send a support request; the team replies by email.',
    obj(
      {
        subject: s('Short subject'),
        body: s('What happened, what you expected'),
        type: s('Kind', { enum: ['problem', 'feature_request', 'question', 'other'] }),
        attachments: {
          type: 'array',
          items: obj({ name: s('File name'), url: s('File URL') }, ['name', 'url']),
        },
      },
      ['subject', 'body'],
    ),
    ['route:POST /api/support', 'page:/support'],
  ),
  def(
    'list_support_tickets',
    'read',
    'List support tickets',
    'Your earlier support requests.',
    obj(),
  ),
  // keys and scopes
  def(
    'list_api_keys',
    'read',
    'List API keys',
    'Keys with name, prefix, scopes, last used.',
    obj(),
  ),
  def(
    'create_api_key',
    'keys',
    'Create API key',
    'Ask the user which permissions the key needs; never choose for them. Creates a key and returns the secret once. Omit tiers for all.',
    obj({ name: s('Key name'), tiers: { type: 'array', items: s('Tier') } }, ['name']),
    ['action:createKeyAction', 'action:createOnboardingKey'],
  ),
  def(
    'rotate_api_key',
    'keys',
    'Rotate API key',
    'Creates a replacement with the same scopes and returns the secret once; the old key keeps working until you revoke it.',
    obj({ keyId: s('Key id') }, ['keyId']),
  ),
  def(
    'revoke_api_key',
    'keys',
    'Revoke API key',
    'Deletes a key immediately. Needs a confirmToken.',
    obj({ keyId: s('Key id'), ...CONFIRM }, ['keyId']),
    ['action:deleteKeyAction'],
  ),
  def(
    'list_granted_scopes',
    'read',
    'Granted permissions',
    'Tiers and scopes this connection holds.',
    obj(),
  ),
  def(
    'request_scopes',
    'read',
    'Request permissions',
    'Returns a click-ready link where the user grants more permission tiers to this connection.',
    obj({ tiers: { type: 'array', items: s('Tier') } }, ['tiers']),
    ['action:updateTiersAction'],
  ),
  // connections
  def(
    'list_connections',
    'read',
    'List connected apps',
    'AI apps connected to this account and when each last ran.',
    obj(),
    ['page:/dashboard/settings#connected-apps'],
  ),
  def(
    'get_connect_links',
    'connections',
    'Connect another agent',
    'Install links for Claude, Cursor, VS Code, Claude Code, Codex and OpenCode.',
    obj({ agent: s('Optional agent id') }),
  ),
  def(
    'disconnect',
    'connections',
    'Disconnect an app',
    'Revokes a connected app immediately. Needs a confirmToken.',
    obj({ clientId: s('Client id from list_connections'), ...CONFIRM }, ['clientId']),
    ['action:disconnectAppAction'],
  ),
  // BYO APIs and proxy
  def(
    'list_user_apis',
    'read',
    'List my APIs',
    'Remote-URL APIs you published to your workspace.',
    obj(),
    ['page:/dashboard/operations'],
  ),
  def(
    'create_user_api',
    'write',
    'Create my API',
    'Publish a remote HTTP API as an operation.',
    obj(
      {
        name: s('Name'),
        slug: s('lowercase-with-dots-or-hyphens'),
        description: s('What it does'),
        category: s('Category'),
        execution: obj(
          {
            remoteUrl: { type: 'string' },
            httpMethod: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            bodyMode: { type: 'string', enum: ['none', 'passthrough', 'template'] },
            timeoutMs: { type: 'integer' },
          },
          ['remoteUrl'],
        ),
        inputFields: INPUT_FIELDS,
        secretHeaders: { type: 'object', additionalProperties: { type: 'string' } },
      },
      ['name', 'slug', 'execution', 'inputFields'],
    ),
    ['route:POST /api/user-apis'],
  ),
  def(
    'update_user_api',
    'write',
    'Update my API',
    'Change one of your published APIs. Fields you leave out of the patch keep their stored value, including secret headers.',
    obj({ slug: s('Slug'), patch: { type: 'object', additionalProperties: true } }, [
      'slug',
      'patch',
    ]),
    ['route:PATCH /api/user-apis/[slug]'],
    true,
  ),
  def(
    'delete_user_api',
    'destructive',
    'Delete my API',
    'Deletes a published API. Needs a confirmToken.',
    obj({ slug: s('Slug'), ...CONFIRM }, ['slug']),
    ['route:DELETE /api/user-apis/[slug]', 'action:deleteApiAction'],
  ),
  def(
    'get_proxy_config',
    'read',
    'Get proxy config',
    'Proxy URLs used for outbound requests.',
    obj(),
    ['action:getOnboardingState'],
  ),
  def(
    'set_proxy_config',
    'write',
    'Set proxy config',
    'Replace the proxy URL list.',
    obj({ proxyUrls: { type: 'array', items: s('Proxy URL') } }, ['proxyUrls']),
    ['route:PUT /api/user-apis/proxy-config', 'action:saveProxyConfig'],
    true,
  ),
  def(
    'test_proxy_config',
    'write',
    'Test a proxy',
    'Check that a proxy URL works.',
    obj({ proxyUrl: s('Proxy URL') }, ['proxyUrl']),
    ['route:POST /api/user-apis/proxy-config/test', 'action:testProxyHealth', 'action:testDemoApi'],
    true,
  ),
  // hosted functions
  def('list_hosted_functions', 'read', 'List hosted functions', 'Your deployed functions.', obj(), [
    'route:GET /api/user-functions',
  ]),
  def(
    'get_hosted_function',
    'read',
    'Get hosted function',
    'One function including its code.',
    obj({ slug: s('Slug') }, ['slug']),
    ['route:GET /api/user-functions/[slug]'],
  ),
  def(
    'deploy_hosted_function',
    'write',
    'Deploy hosted function',
    'Create a function from code.',
    obj(
      {
        name: s('Name'),
        slug: s('Slug'),
        code: s('Source'),
        description: s('About'),
        secrets: { type: 'object', additionalProperties: { type: 'string' } },
        inputFields: INPUT_FIELDS,
        category: s('Category'),
        tags: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'integer' },
      },
      ['name', 'slug', 'code'],
    ),
    ['route:POST /api/user-functions'],
  ),
  def(
    'update_hosted_function',
    'write',
    'Update hosted function',
    'Change code, description, secrets, input fields, category, tags or timeout. Secrets you leave out of the patch are kept.',
    obj({ slug: s('Slug'), patch: { type: 'object', additionalProperties: true } }, [
      'slug',
      'patch',
    ]),
    ['route:PUT /api/user-functions/[slug]', 'route:PATCH /api/user-functions/[slug]'],
    true,
  ),
  def(
    'delete_hosted_function',
    'destructive',
    'Delete hosted function',
    'Deletes a function. Needs a confirmToken.',
    obj({ slug: s('Slug'), ...CONFIRM }, ['slug']),
    ['route:DELETE /api/user-functions/[slug]'],
  ),
  // products
  def('list_products', 'read', 'List products', 'Products and the operations in each.', obj(), [
    'page:/dashboard/products',
  ]),
  def(
    'create_product',
    'write',
    'Create product',
    'Group operations into a product.',
    obj({ name: s('Name'), description: s('About') }, ['name']),
    ['route:POST /api/products'],
  ),
  def(
    'update_product',
    'write',
    'Update product',
    'Rename or redescribe a product.',
    obj({ productId: s('Product id'), name: s('Name'), description: s('About') }, [
      'productId',
      'name',
    ]),
    ['action:updateProductAction'],
    true,
  ),
  def(
    'delete_product',
    'destructive',
    'Delete product',
    'Deletes a product; its operations move to the default product. Needs a confirmToken.',
    obj({ productId: s('Product id'), ...CONFIRM }, ['productId']),
    ['action:deleteProductAction'],
  ),
  def(
    'assign_operation_to_product',
    'write',
    'Move operation into product',
    'Add an operation to a product, or send it back to the default product.',
    obj(
      {
        productId: s('Product id'),
        operationId: s('Operation id'),
        kind: s('Kind', { enum: ['hosted', 'api'] }),
        remove: b('Remove instead of add'),
      },
      ['productId', 'operationId', 'kind'],
    ),
    ['action:addOperationAction', 'action:removeOperationAction'],
    true,
  ),
  // referral and uploads
  def('get_referral', 'read', 'Referral program', 'Your referral link and earnings.', obj(), [
    'route:GET /api/settings/referral',
    'route:GET /api/referral/ui-state',
  ]),
  def(
    'update_referral_ui_state',
    'account',
    'Referral prompts',
    'Dismiss or answer the referral prompts.',
    obj({ patch: { type: 'object', additionalProperties: true } }, ['patch']),
    ['route:PATCH /api/referral/ui-state'],
    true,
  ),
  def(
    'create_upload_url',
    'write',
    'Create upload URL',
    'A presigned upload URL for a file input of an operation.',
    obj({ fileName: s('Name'), contentType: s('MIME type'), size: n('Bytes') }, [
      'fileName',
      'contentType',
      'size',
    ]),
    ['route:GET /api/uploads/presign', 'route:POST /api/uploads/presign'],
  ),
];

export const ACCOUNT_TOOL_NAMES: readonly string[] = ACCOUNT_TOOL_DEFS.map((d) => d.name);

/** Runs one account tool. Hosted: in-process. stdio: HTTP to the gateway. Reject with a DenialError to refuse. */
export type AccountCaller = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

export function createAccountToolEntries(options: {
  caller: AccountCaller;
  tiers?: ReadonlySet<Tier> | undefined;
}): McpToolEntry[] {
  const { caller, tiers } = options;
  return ACCOUNT_TOOL_DEFS.map((d) => ({
    name: d.name,
    title: d.title,
    description: d.description,
    inputSchema: d.inputSchema,
    annotations: d.annotations,
    tier: d.tier,
    call: async (input: unknown) => {
      // Early, cheap refusal when the host knows the grant. The host re-checks in `runAccountTool`;
      // this copy exists so a stdio server (which cannot see the key's scopes) and a hosted one answer alike.
      if (tiers && !tiers.has(d.tier)) {
        return renderDenial(
          denial('SCOPE_MISSING', `This action needs the "${TIER_LABEL[d.tier]}" permission.`, {
            tool: 'request_scopes',
            args: { tiers: [d.tier] },
          }).denial,
        );
      }
      try {
        const out = await caller(
          d.name,
          (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof out === 'string' ? out : JSON.stringify(out ?? { ok: true }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatToolFailure(d.name, toToolFailure(err)) }],
          isError: true,
        };
      }
    },
  }));
}
