/*
 * voicecode-audio-out — plays raw PCM from stdin into a Windows playback device, so
 * the VoiceCode agent can feed a phone's microphone into a virtual audio cable
 * (VB-CABLE: play into "CABLE Input", record from "CABLE Output") for Claude Code's
 * own dictation.
 *
 *   voicecode-audio-out [--device <name substring>] [--rate <hz>]
 *       Opens the first playback device whose name contains the substring (default
 *       "CABLE Input"), prints "ready platform=win32 protocol=1 device=<name>" (spaces
 *       in the name shown as underscores) and then plays signed 16-bit little-endian
 *       mono audio read from stdin until EOF. Problems are "err <message>" lines.
 *   voicecode-audio-out --list
 *       Prints "out <name>" for every playback device.
 *   voicecode-audio-out --default-capture
 *       Prints "capture <name>" for the default recording device (what Claude Code records).
 *
 * waveOut is used on purpose: it is simple, available everywhere, and the Windows audio
 * engine resamples to the device's format, so the cable may run at any rate.
 *
 * Build (MinGW): gcc -O2 -municode -o voicecode-audio-out.exe voicecode-audio-out.c -lwinmm -lole32
 * Build (MSVC):  cl /O2 voicecode-audio-out.c winmm.lib ole32.lib
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmsystem.h>
#include <fcntl.h>
#include <io.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define BUFFERS 16
#define CHUNK_MS 100

static void reply(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stdout, fmt, args);
    va_end(args);
    fputc('\n', stdout);
    fflush(stdout);
}

static void print_wide(const char *prefix, const wchar_t *text, int underscores) {
    char utf8[512];
    int n = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, sizeof(utf8), NULL, NULL);
    if (n <= 0) utf8[0] = 0;
    if (underscores) {
        for (char *p = utf8; *p; p++) {
            if (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') *p = '_';
        }
    }
    reply("%s%s", prefix, utf8);
}

static int contains_nocase(const wchar_t *haystack, const wchar_t *needle) {
    size_t n = wcslen(needle);
    if (n == 0) return 1;
    for (const wchar_t *p = haystack; *p; p++) {
        if (_wcsnicmp(p, needle, n) == 0) return 1;
    }
    return 0;
}

static int list_devices(void) {
    UINT count = waveOutGetNumDevs();
    for (UINT i = 0; i < count; i++) {
        WAVEOUTCAPSW caps;
        if (waveOutGetDevCapsW(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR) {
            print_wide("out ", caps.szPname, 0);
        }
    }
    return 0;
}

/* The device Claude Code records from: the system default capture endpoint. */
static int default_capture(void) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        reply("err CoInitializeEx failed (0x%08lx)", (unsigned long)hr);
        return 1;
    }
    IMMDeviceEnumerator *enumerator = NULL;
    IMMDevice *device = NULL;
    IPropertyStore *store = NULL;
    int result = 1;
    hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator,
                          (void **)&enumerator);
    if (FAILED(hr)) {
        reply("err MMDeviceEnumerator unavailable (0x%08lx)", (unsigned long)hr);
        goto done;
    }
    hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, eCapture, eConsole, &device);
    if (FAILED(hr)) {
        reply("err no default recording device (0x%08lx)", (unsigned long)hr);
        goto done;
    }
    hr = IMMDevice_OpenPropertyStore(device, STGM_READ, &store);
    if (FAILED(hr)) {
        reply("err cannot read device properties (0x%08lx)", (unsigned long)hr);
        goto done;
    }
    PROPVARIANT name;
    PropVariantInit(&name);
    hr = IPropertyStore_GetValue(store, &PKEY_Device_FriendlyName, &name);
    if (SUCCEEDED(hr) && name.vt == VT_LPWSTR) {
        print_wide("capture ", name.pwszVal, 0);
        result = 0;
    } else {
        reply("err device has no name (0x%08lx)", (unsigned long)hr);
    }
    PropVariantClear(&name);
done:
    if (store) IPropertyStore_Release(store);
    if (device) IMMDevice_Release(device);
    if (enumerator) IMMDeviceEnumerator_Release(enumerator);
    CoUninitialize();
    return result;
}

static int find_device(const wchar_t *needle, WAVEOUTCAPSW *found) {
    UINT count = waveOutGetNumDevs();
    for (UINT i = 0; i < count; i++) {
        WAVEOUTCAPSW caps;
        if (waveOutGetDevCapsW(i, &caps, sizeof(caps)) != MMSYSERR_NOERROR) continue;
        if (contains_nocase(caps.szPname, needle)) {
            *found = caps;
            return (int)i;
        }
    }
    return -1;
}

static int play(const wchar_t *needle, DWORD rate) {
    WAVEOUTCAPSW caps;
    int index = find_device(needle, &caps);
    if (index < 0) {
        char utf8[256];
        WideCharToMultiByte(CP_UTF8, 0, needle, -1, utf8, sizeof(utf8), NULL, NULL);
        reply("err no playback device matching \"%s\" (is VB-CABLE installed?)", utf8);
        return 2;
    }

    WAVEFORMATEX fmt;
    ZeroMemory(&fmt, sizeof(fmt));
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.nChannels = 1;
    fmt.nSamplesPerSec = rate;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = 2;
    fmt.nAvgBytesPerSec = rate * 2;

    HANDLE event = CreateEventW(NULL, FALSE, FALSE, NULL);
    HWAVEOUT out = NULL;
    MMRESULT mr = waveOutOpen(&out, (UINT)index, &fmt, (DWORD_PTR)event, 0, CALLBACK_EVENT);
    if (mr != MMSYSERR_NOERROR) {
        reply("err waveOutOpen failed (error %u)", (unsigned)mr);
        return 3;
    }

    size_t chunk = (size_t)rate / 1000 * CHUNK_MS * 2;
    WAVEHDR headers[BUFFERS];
    ZeroMemory(headers, sizeof(headers));
    for (int i = 0; i < BUFFERS; i++) headers[i].lpData = (LPSTR)malloc(chunk);

    print_wide("ready platform=win32 protocol=1 device=", caps.szPname, 1);

    _setmode(_fileno(stdin), _O_BINARY);
    int fd = _fileno(stdin);
    char carry = 0;
    int have_carry = 0;
    int next = 0;
    for (;;) {
        /* Buffers are used in ring order; wait for the device to finish the oldest one. */
        WAVEHDR *h = &headers[next];
        while ((h->dwFlags & WHDR_PREPARED) && !(h->dwFlags & WHDR_DONE)) {
            WaitForSingleObject(event, 200);
        }
        if (h->dwFlags & WHDR_PREPARED) waveOutUnprepareHeader(out, h, sizeof(*h));

        char *data = h->lpData;
        size_t have = 0;
        if (have_carry) {
            data[0] = carry;
            have = 1;
            have_carry = 0;
        }
        int n = _read(fd, data + have, (unsigned)(chunk - have));
        if (n <= 0) break;
        have += (size_t)n;
        if (have % 2) {
            /* Keep a dangling byte for the next read so samples stay aligned. */
            carry = data[have - 1];
            have_carry = 1;
            have--;
        }
        if (have == 0) continue;

        h->dwBufferLength = (DWORD)have;
        h->dwFlags = 0;
        mr = waveOutPrepareHeader(out, h, sizeof(*h));
        if (mr == MMSYSERR_NOERROR) mr = waveOutWrite(out, h, sizeof(*h));
        if (mr != MMSYSERR_NOERROR) {
            reply("err waveOutWrite failed (error %u)", (unsigned)mr);
            break;
        }
        next = (next + 1) % BUFFERS;
    }

    /* Let what is queued finish (bounded), then release everything. */
    for (int round = 0; round < 50; round++) {
        int busy = 0;
        for (int i = 0; i < BUFFERS; i++) {
            if ((headers[i].dwFlags & WHDR_PREPARED) && !(headers[i].dwFlags & WHDR_DONE)) busy = 1;
        }
        if (!busy) break;
        WaitForSingleObject(event, 100);
    }
    waveOutReset(out);
    for (int i = 0; i < BUFFERS; i++) {
        if (headers[i].dwFlags & WHDR_PREPARED) waveOutUnprepareHeader(out, &headers[i], sizeof(headers[i]));
        free(headers[i].lpData);
    }
    waveOutClose(out);
    CloseHandle(event);
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    const wchar_t *device = L"CABLE Input";
    DWORD rate = 16000;
    for (int i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--list") == 0) return list_devices();
        if (wcscmp(argv[i], L"--default-capture") == 0) return default_capture();
        if (wcscmp(argv[i], L"--device") == 0 && i + 1 < argc) {
            device = argv[++i];
        } else if (wcscmp(argv[i], L"--rate") == 0 && i + 1 < argc) {
            rate = (DWORD)_wtoi(argv[++i]);
        } else {
            reply("err unknown argument");
            return 1;
        }
    }
    if (rate < 8000 || rate > 48000) {
        reply("err rate must be between 8000 and 48000");
        return 1;
    }
    return play(device, rate);
}
