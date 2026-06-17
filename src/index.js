// ========== 优化版：增强流式传输和下载体验 ==========
// 修改点：
// 1. 保留 Content-Length 头，支持下载进度显示
// 2. 支持 HTTP Range 请求，实现断点续传
// 3. 优化大文件缓存策略
// 4. 为下载文件添加 Content-Disposition 头

// ========== 全局配置 ==========
const domain_whitelist = [
  "github.com",
  "avatars.githubusercontent.com",
  "github.githubassets.com",
  "collector.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "github.io",
  "assets-cdn.github.com",
  "cdn.jsdelivr.net",
  "securitylab.github.com",
  "www.githubstatus.com",
  "npmjs.com",
  "git-lfs.github.com",
  "githubusercontent.com",
  "github.global.ssl.fastly.net",
  "api.npms.io",
  "github.community",
  "desktop.github.com",
  "central.github.com"
];

const domain_mappings = Object.fromEntries(
  domain_whitelist.map((domain) => [domain, domain.replace(/\./g, "-") + "-"])
);

const redirect_paths = [];
const enable_geo_redirect = true;

// ========== 核心处理函数 ==========
async function handleRequest(request) {
  const url = new URL(request.url);
  const current_host = url.host.toLowerCase();
  const host_header = request.headers.get("Host");
  const effective_host = (host_header || current_host).toLowerCase();

  // 地理重定向（非中国大陆用户跳转回原始域名）
  if (enable_geo_redirect) {
    const country = request.headers.get("CF-IPCountry") || "";
    if (country && country !== "CN") {
      const host_prefix2 = getProxyPrefix(effective_host);
      if (host_prefix2) {
        let target_host2 = null;
        if (host_prefix2 && host_prefix2.endsWith("-gh.")) {
          const prefix_part = host_prefix2.slice(0, -4);
          for (const original of Object.keys(domain_mappings)) {
            const normalized_original = original.trim().toLowerCase();
            if (normalized_original.replace(/\./g, "-") === prefix_part) {
              target_host2 = original;
              break;
            }
          }
        }
        if (target_host2) {
          const domain_suffix = effective_host.substring(host_prefix2.length);
          const original_url = new URL(request.url);
          original_url.host = target_host2;
          original_url.protocol = "https:";
          return Response.redirect(original_url.href, 302);
        }
      }
    }
  }

  // 路径黑名单
  if (redirect_paths.includes(url.pathname)) {
    return new Response("Not Found", { status: 404 });
  }

  // HTTP 强制跳转 HTTPS
  if (url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.href);
  }

  const host_prefix = getProxyPrefix(effective_host);
  if (!host_prefix) {
    return new Response(`Domain not configured for proxy. Host: ${effective_host}, Prefix check failed`, { status: 404 });
  }

  let target_host = null;
  if (host_prefix && host_prefix.endsWith("-gh.")) {
    const prefix_part = host_prefix.slice(0, -4);
    for (const original of Object.keys(domain_mappings)) {
      const normalized_original = original.trim().toLowerCase();
      if (normalized_original.replace(/\./g, "-") === prefix_part) {
        target_host = original;
        break;
      }
    }
  }

  if (!target_host) {
    return new Response(`Domain not configured for proxy. Host: ${effective_host}, Prefix: ${host_prefix}, Target lookup failed`, { status: 404 });
  }

  let pathname = url.pathname;
  pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https%3A\/\/[^\/]+\/.*/, "$1");
  pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https:\/\/[^\/]+\/.*/, "$1");

  const new_url = new URL(url);
  new_url.host = target_host;
  new_url.pathname = pathname;
  new_url.protocol = "https:";

  const new_headers = new Headers(request.headers);
  new_headers.set("Host", target_host);
  new_headers.set("Referer", new_url.href);
  new_headers.delete("accept-encoding");

  // ✅ 优化1：保留 Range 头，支持断点续传
  const range_header = request.headers.get("range");
  if (range_header) {
    new_headers.set("range", range_header);
  }

  try {
    const response = await fetch(new_url.href, {
      method: request.method,
      headers: new_headers,
      body: request.method !== "GET" ? request.body : void 0,
      redirect: "manual"
    });

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location) {
        const modified_location = modifyUrl(location, host_prefix, effective_host);
        const new_res_headers = new Headers(response.headers);
        new_res_headers.set("location", modified_location);
        return new Response(null, {
          status: response.status,
          headers: new_res_headers
        });
      }
    }

    const new_response_headers = new Headers(response.headers);
    new_response_headers.set("access-control-allow-origin", "*");
    new_response_headers.set("access-control-allow-credentials", "true");
    new_response_headers.delete("content-security-policy");
    new_response_headers.delete("content-security-policy-report-only");
    new_response_headers.delete("clear-site-data");

    const content_type = response.headers.get("content-type") || "";
    const content_length = response.headers.get("content-length");
    const content_length_num = parseInt(content_length || "0", 10);

    const is_text = content_type.includes("text/") ||
                    content_type.includes("application/json") ||
                    content_type.includes("application/javascript") ||
                    content_type.includes("application/xml");

    // 文本内容需要替换域名
    if (response.status === 200 && is_text) {
      new_response_headers.delete("content-encoding");
      new_response_headers.delete("content-length");
      new_response_headers.set("cache-control", "public, max-age=14400"); // 4小时
      let text = await response.text();
      text = await modifyText(text, host_prefix, effective_host);
      return new Response(text, {
        status: response.status,
        headers: new_response_headers
      });
    }

    // ✅ 优化2：二进制文件流式传输增强
    // 保留 Content-Length，支持下载进度显示
    if (content_length) {
      new_response_headers.set("content-length", content_length);
    }

    // ✅ 优化3：支持 206 Partial Content（断点续传）
    if (response.status === 206) {
      const content_range = response.headers.get("content-range");
      if (content_range) {
        new_response_headers.set("content-range", content_range);
      }
      new_response_headers.set("accept-ranges", "bytes");
    } else {
      // 告知客户端支持 Range 请求
      new_response_headers.set("accept-ranges", "bytes");
    }

    // ✅ 优化4：大文件优化缓存策略
    const is_large_file = content_length_num > 10 * 1024 * 1024; // 10MB 以上
    if (is_large_file) {
      new_response_headers.set("cache-control", "public, max-age=86400"); // 24小时
    } else {
      new_response_headers.set("cache-control", "public, max-age=14400"); // 4小时
    }

    // ✅ 优化5：识别下载文件，添加 Content-Disposition
    const is_download = isDownloadableFile(pathname, content_type);
    if (is_download) {
      const filename = pathname.split("/").pop() || "download";
      new_response_headers.set("content-disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    }

    // 流式传输响应体
    return new Response(response.body, {
      status: response.status,
      headers: new_response_headers
    });
  } catch (err) {
    return new Response(`Proxy Error: ${err.message}`, { status: 502 });
  }
}

// ========== 辅助函数 ==========
function getProxyPrefix(host) {
  const ghMatch = host.match(/^([a-z0-9-]+-gh\.)/);
  if (ghMatch) {
    return ghMatch[1];
  }
  return null;
}

async function modifyText(text, host_prefix, effective_hostname) {
  const domain_suffix = effective_hostname.substring(host_prefix.length);
  for (const [original_domain, _] of Object.entries(domain_mappings)) {
    const escaped_domain = original_domain.replace(/\./g, "\\.");
    const current_prefix = original_domain.replace(/\./g, "-") + "-gh.";
    const full_proxy_domain = `${current_prefix}${domain_suffix}`;
    text = text.replace(
      new RegExp(`https?://${escaped_domain}(?=/|"|'|\\s|$)`, "g"),
      `https://${full_proxy_domain}`
    );
    text = text.replace(
      new RegExp(`//${escaped_domain}(?=/|"|'|\\s|$)`, "g"),
      `//${full_proxy_domain}`
    );
  }
  return text;
}

function modifyUrl(url_str, host_prefix, effective_hostname) {
  try {
    const url = new URL(url_str);
    const domain_suffix = effective_hostname.substring(host_prefix.length);
    for (const [original_domain, _] of Object.entries(domain_mappings)) {
      if (url.host === original_domain) {
        const current_prefix = original_domain.replace(/\./g, "-") + "-gh.";
        url.host = `${current_prefix}${domain_suffix}`;
        break;
      }
    }
    return url.href;
  } catch (e) {
    return url_str;
  }
}

// ✅ 新增：判断是否为可下载文件
function isDownloadableFile(pathname, content_type) {
  // 常见下载文件扩展名
  const download_extensions = [
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
    ".exe", ".dmg", ".pkg", ".deb", ".rpm", ".apk",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".iso", ".img", ".bin",
    ".jar", ".war", ".ear"
  ];

  const lower_path = pathname.toLowerCase();
  const has_download_ext = download_extensions.some(ext => lower_path.endsWith(ext));

  // GitHub Release 资产路径
  const is_release_asset = pathname.includes("/releases/download/");

  // 特定 MIME 类型
  const downloadable_types = [
    "application/zip",
    "application/x-tar",
    "application/gzip",
    "application/x-gzip",
    "application/octet-stream",
    "application/x-msdownload",
    "application/vnd.debian.binary-package"
  ];
  const has_download_type = downloadable_types.some(type => content_type.includes(type));

  return has_download_ext || is_release_asset || has_download_type;
}

// ========== ES Module 导出 ==========
export default {
  fetch(request) {
    return handleRequest(request);
  }
};
