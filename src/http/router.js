/**
 * A tiny method + path-pattern router. No dependencies, no regex construction
 * from user input: patterns are split into literal segments and `:params`.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({
      method: String(method).toUpperCase(),
      pattern,
      segments: splitPath(pattern),
      handler,
      public: options.public === true,
    });
    return this;
  }

  get(pattern, handler, options) {
    return this.add('GET', pattern, handler, options);
  }

  post(pattern, handler, options) {
    return this.add('POST', pattern, handler, options);
  }

  patch(pattern, handler, options) {
    return this.add('PATCH', pattern, handler, options);
  }

  delete(pattern, handler, options) {
    return this.add('DELETE', pattern, handler, options);
  }

  /** Returns { route, params } or null. Unknown paths and unknown methods both miss. */
  match(method, pathname) {
    const requested = String(method).toUpperCase();
    const parts = splitPath(pathname);

    for (const route of this.routes) {
      if (route.method !== requested) continue;
      if (route.segments.length !== parts.length) continue;

      const params = {};
      let matched = true;

      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) {
          let value = parts[index];
          try {
            value = decodeURIComponent(value);
          } catch {
            matched = false;
            break;
          }
          params[segment.slice(1)] = value;
          continue;
        }
        if (segment !== parts[index]) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params };
    }

    return null;
  }
}

function splitPath(pathname) {
  return String(pathname ?? '/')
    .split('/')
    .filter((segment) => segment.length > 0);
}
