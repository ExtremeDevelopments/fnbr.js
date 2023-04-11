import { Collection } from '@discordjs/collection';
import Base from '../Base';
import UserNotFoundError from '../exceptions/UserNotFoundError';
import { chunk } from '../util/Util';
import Endpoints from '../../resources/Endpoints';
import EpicgamesAPIError from '../exceptions/EpicgamesAPIError';
import { AuthSessionStoreKey } from '../../resources/enums';
import UserSearchResult from '../structures/user/UserSearchResult';
import AuthenticationMissingError from '../exceptions/AuthenticationMissingError';
import User from '../structures/user/User';
import Avatar from '../structures/Avatar';
import GlobalProfile from '../structures/GlobalProfile';
import type BlockedUser from '../structures/user/BlockedUser';
import type { UserSearchPlatform } from '../../resources/structs';
import type ClientUser from '../structures/user/ClientUser';
import type Client from '../Client';

class UserManager extends Base {
  public blocklist: Collection<string, BlockedUser>;
  public self?: ClientUser;
  constructor(client: Client) {
    super(client);

    this.blocklist = new Collection();
    this.self = undefined;
  }

  public async resolveId(idOrDisplayName: string) {
    if (idOrDisplayName.length === 32) {
      return idOrDisplayName;
    }

    const user = await this.fetch(idOrDisplayName);
    return user.id;
  }

  public async fetch(idOrDisplayName: string) {
    const [user] = await this.fetchMultiple([idOrDisplayName]);

    if (!user) {
      throw new UserNotFoundError(idOrDisplayName);
    }

    return user;
  }

  public async fetchMultiple(idsOrDisplayNames: string[]): Promise<User[]> {
    const ids = [];
    const displayNames = [];

    for (const idOrDisplayName of idsOrDisplayNames) {
      if (idOrDisplayName.length === 32) {
        ids.push(idOrDisplayName);
      } else if (idOrDisplayName.length > 3 && idOrDisplayName.length < 16) {
        displayNames.push(idOrDisplayName);
      }
    }

    const idChunks = chunk(ids, 100);

    const users = await Promise.all([
      ...idChunks.map((c) => this.client.http.epicgamesRequest({
        method: 'GET',
        url: `${Endpoints.ACCOUNT_MULTIPLE}?accountId=${c.join('&accountId=')}`,
      }, AuthSessionStoreKey.Fortnite)),
      ...displayNames.map((d) => this.client.http.epicgamesRequest({
        method: 'GET',
        url: `${Endpoints.ACCOUNT_DISPLAYNAME}/${d}`,
      }, AuthSessionStoreKey.Fortnite).catch((e) => {
        if (e instanceof EpicgamesAPIError && e.code === 'errors.com.epicgames.account.account_not_found') {
          return undefined;
        }

        return Promise.reject(e);
      })),
    ]);

    return users.flat(1).filter((u) => !!u).map((u) => new User(this.client, u));
  }

  public async fetchSelf() {
    if (!this.client.auth.sessions.has(AuthSessionStoreKey.Fortnite)) {
      throw new AuthenticationMissingError(AuthSessionStoreKey.Fortnite);
    }

    this.self = await this.fetch(this.client.auth.sessions.get(AuthSessionStoreKey.Fortnite)!.accountId) as ClientUser;
  }

  public async search(prefix: string, platform: UserSearchPlatform = 'epic') {
    const results = await this.client.http.epicgamesRequest({
      method: 'GET',
      url: `${Endpoints.ACCOUNT_SEARCH}/${this.self!.id}?prefix=${encodeURIComponent(prefix)}&platform=${platform}`,
    }, AuthSessionStoreKey.Fortnite);

    const users = await this.fetchMultiple(results.map((r: any) => r.accountId) as string[]);

    return results
      .filter((r: any) => users.some((u) => u.id === r.accountId))
      .map((r: any) => new UserSearchResult(this.client, users.find((u) => u.id === r.accountId)!, r));
  }

  /**
   * Fetches the avatar of a user
   * @param user The id or display name of the user
   * @throws {EpicgamesAPIError}
   * @throws {UserNotFoundError} The user wasn't found
   */
  public async fetchAvatar(idOrDisplayName: string) {
    const [avatar] = await this.fetchAvatarMultiple([idOrDisplayName]);

    if (!avatar) {
      throw new UserNotFoundError(idOrDisplayName);
    }

    return avatar;
  }

  /**
   * Fetches the avatar of multiple users
   * @param user The ids and/or display names of the users
   * @throws {EpicgamesAPIError}
   */
  public async fetchAvatarMultiple(idsOrDisplayNames: string[]) {
    const users = await this.fetchMultiple(idsOrDisplayNames);

    const userChunks = chunk(users, 100);

    const avatars = await Promise.all(userChunks.map((uc) => this.client.http.epicgamesRequest({
      method: 'GET',
      url: `${Endpoints.ACCOUNT_AVATAR}/fortnite/ids?accountIds=${uc.map((u) => u.id).join(',')}`,
    }, AuthSessionStoreKey.Fortnite)));

    return avatars
      .map((a) => a.map((ar: any) => new Avatar(this.client, ar, users.find((u) => u.id === ar.accountId)!)))
      .flat(1);
  }

  /**
   * Fetches the global profile of a user
   * @param user The id or display name of the user
   * @throws {EpicgamesAPIError}
   * @throws {UserNotFoundError} The user wasn't found
   */
  public async fetchGlobalProfile(idOrDisplayName: string) {
    const [profile] = await this.fetchGlobalProfileMultiple([idOrDisplayName]);

    if (!profile) {
      throw new UserNotFoundError(idOrDisplayName);
    }

    return profile;
  }

  /**
   * Fetches the global profile for multiple users
   * @param user The ids and/or display names of the users
   * @throws {EpicgamesAPIError}
   */
  public async fetchGlobalProfileMultiple(idsOrDisplayNames: string[]) {
    const users = await this.fetchMultiple(idsOrDisplayNames);

    const userChunks = chunk(users, 100);

    const globalProfiles = await Promise.all(userChunks.map((uc) => this.client.http.epicgamesRequest({
      method: 'PUT',
      url: Endpoints.ACCOUNT_GLOBAL_PROFILE,
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        namespace: 'Fortnite',
        accountIds: uc.map((u) => u.id),
      },
    }, AuthSessionStoreKey.Fortnite)));

    return globalProfiles
      .map((a) => a.profiles.map((ar: any) => new GlobalProfile(this.client, ar, users.find((u) => u.id === ar.accountId)!)))
      .flat(1);
  }

  /**
   * Blocks a user
   * @param user The id or display name of the user
   * @throws {UserNotFoundError} The user wasn't found
   * @throws {EpicgamesAPIError}
   */
  public async block(user: string) {
    const userId = await this.resolveId(user);
    if (!userId) throw new UserNotFoundError(user);

    await this.client.http.epicgamesRequest({
      method: 'POST',
      url: `${Endpoints.FRIEND_BLOCK}/${this.self!.id}/${userId}`,
    }, AuthSessionStoreKey.Fortnite);
  }

  /**
   * Unblocks a user
   * @param user The id or display name of the user
   * @throws {UserNotFoundError} The user wasn't found
   * @throws {EpicgamesAPIError}
   */
  public async unblock(user: string) {
    const blockedUser = this.blocklist.find((u) => u.displayName === user || u.id === user);
    if (!blockedUser) throw new UserNotFoundError(user);

    await this.client.http.epicgamesRequest({
      method: 'DELETE',
      url: `${Endpoints.FRIEND_BLOCK}/${this.self!.id}/${blockedUser.id}`,
    }, AuthSessionStoreKey.Fortnite);
  }
}

export default UserManager;