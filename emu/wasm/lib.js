// xiaonux: JS side of the TinyEMU WASM build, for a Web Worker (no DOM).
// The worker sets these hooks on the Module object before calling vm_start:
//   Module.onConsole(Uint8Array)   guest console output (copy it if kept)
//   Module.consoleSize             [cols, rows]
//   Module.onReady()               VM is built and can run
//   Module.onDownloading(bool)     a fetch is in flight
//   Module.onFetch(url, bytes)     every completed fetch (for stats)
//   Module.baseUrl                 base for relative URLs (the .cfg's directory)
//   Module.disk                    chunked disk callbacks (Phase 2):
//     fetchChunk(block, hashIndex), overlayRead(cluster, ptr) -> bool,
//     overlayWrite(cluster, ptr), event(kind, block, value)
addToLibrary({
  js_fetch_chunk: function (block, hashIndex) {
    Module.disk.fetchChunk(block, hashIndex);
  },
  js_overlay_read: function (cluster, ptr) {
    return Module.disk.overlayRead(cluster, ptr) ? 1 : 0;
  },
  js_overlay_write: function (cluster, ptr) {
    Module.disk.overlayWrite(cluster, ptr);
  },
  js_disk_event: function (kind, block, value) {
    if (Module.disk.event) Module.disk.event(kind, block, value);
  },

  console_write: function (opaque, buf, len) {
    Module.onConsole(HEAPU8.subarray(buf, buf + len));
  },

  console_get_size: function (pw, ph) {
    var r = Module.consoleSize || [80, 24];
    HEAPU32[pw >> 2] = r[0];
    HEAPU32[ph >> 2] = r[1];
  },

  vm_on_ready: function () {
    if (Module.onReady) Module.onReady();
  },

  net_recv_packet: function (bs, buf, len) {
    // Phase 3: hand guest Ethernet frames to slirp/WISP. Dropped for now.
  },

  fs_export_file: function (filename, buf, len) {},

  fb_refresh: function (opaque, data, x, y, w, h, stride) {},

  fs_wget_update_downloading: function (flag) {
    if (Module.onDownloading) Module.onDownloading(Boolean(flag));
  },

  // Async HTTP GET/POST used by TinyEMU's config loader and HTTP block device.
  // onload(handle, arg, buf, len) / onerror(handle, arg, status, text).
  emscripten_async_wget3_data__deps: ['malloc', 'free'],
  emscripten_async_wget3_data: function (url, request, user, password,
      post_data, post_data_len, arg, free, onload, onerror, onprogress) {
    // Relative paths in the .cfg are relative to the .cfg, not the worker.
    var _url = new URL(UTF8ToString(url), Module.baseUrl || self.location.href).href;
    var _request = UTF8ToString(request);
    var init = { method: _request, cache: 'default' };
    if (user) {
      init.headers = { Authorization: 'Basic ' +
        btoa(UTF8ToString(user) + ':' + (password ? UTF8ToString(password) : '')) };
    }
    if (_request === 'POST' && post_data_len > 0) {
      init.body = HEAPU8.slice(post_data, post_data + post_data_len);
    }
    var handle = (Module._wgetHandle = (Module._wgetHandle || 0) + 1);
    fetch(_url, init).then(function (r) {
      if (!r.ok) throw { status: r.status, text: r.statusText };
      return r.arrayBuffer();
    }).then(function (ab) {
      var bytes = new Uint8Array(ab);
      if (Module.onFetch) Module.onFetch(_url, bytes.length);
      var p = _malloc(bytes.length || 1);
      HEAPU8.set(bytes, p);
      if (onload) {{{ makeDynCall('viiii', 'onload') }}}(handle, arg, p, bytes.length);
      if (free) _free(p);
    }).catch(function (e) {
      var status = (e && e.status) || 0;
      if (onerror) {{{ makeDynCall('viiii', 'onerror') }}}(handle, arg, status, 0);
    });
    return handle;
  },
});
