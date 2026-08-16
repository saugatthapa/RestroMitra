export class ApiError extends Error {}

async function apiRequest<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-dhankipos-client": "web",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string }).error ?? "Something went wrong. Please try again.",
    );
  }

  return data as T;
}

export const apiGet = <T = unknown>(url: string) => apiRequest<T>("GET", url);
export const apiPost = <T = unknown>(url: string, body: unknown) =>
  apiRequest<T>("POST", url, body);
export const apiPut = <T = unknown>(url: string, body: unknown) =>
  apiRequest<T>("PUT", url, body);
export const apiPatch = <T = unknown>(url: string, body: unknown) =>
  apiRequest<T>("PATCH", url, body);
export const apiDelete = <T = unknown>(url: string) => apiRequest<T>("DELETE", url);
