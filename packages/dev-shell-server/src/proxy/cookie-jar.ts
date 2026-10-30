import { Cookie, CookieJar } from "tough-cookie";

const MAX_COOKIES = 128;
const MAX_COOKIE_BYTES = 4_096;
const MAX_HEADER_BYTES = 32 * 1024;

/** Server-side cookies belong to one frame, never the browser's loopback host. */
export class FrameCookieJar {
  private readonly jar = new CookieJar(undefined, { allowSecureOnLocal: false });

  accept(headers: string[] | undefined, url: URL): void {
    for (const value of (headers ?? []).slice(0, MAX_COOKIES)) {
      if (Buffer.byteLength(value) > MAX_COOKIE_BYTES) continue;
      const cookie = Cookie.parse(value);
      if (!cookie || cookie.key.toLowerCase().startsWith("__dev_shell_")) continue;
      this.jar.setCookieSync(cookie, url.href, { ignoreError: true });
      // An untrusted target must not grow the in-memory jar indefinitely.
      if ((this.jar.serializeSync()?.cookies.length ?? 0) > MAX_COOKIES) this.clear();
    }
  }

  header(url: URL): string {
    const value = this.jar.getCookieStringSync(url.href);
    if (Buffer.byteLength(value) > MAX_HEADER_BYTES) {
      this.clear();
      return "";
    }
    return value;
  }

  clear(): void {
    this.jar.removeAllCookiesSync();
  }
}
