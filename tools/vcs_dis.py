#!/usr/bin/env python3
"""Disassembles the game's compiled shaders (.vcs, version 6).

  vcs_dis.py <file.vcs>                        header and how many combos exist
  vcs_dis.py <file.vcs> <static> [dynamic]     disassembly of one combo
  vcs_dis.py <file.vcs> --list [n]             the first n static combo ids

Windows only: bytecode goes through d3dcompiler_47.dll, which ships with the OS.
"""
import ctypes, lzma, struct, sys

HEADER = struct.Struct('<7I')


class Vcs:
    def __init__(self, path):
        self.buf = open(path, 'rb').read()
        (self.version, self.total, self.dynamic, self.flags, self.centroid, self.nstatic, self.crc) = HEADER.unpack_from(self.buf, 0)
        if self.version != 6:
            raise ValueError(f'version {self.version}, expected 6')
        at = HEADER.size
        self.statics = {}
        for _ in range(self.nstatic):
            cid, off = struct.unpack_from('<II', self.buf, at)
            at += 8
            self.statics[cid] = off
        ndup, = struct.unpack_from('<I', self.buf, at)
        at += 4
        self.aliases = {}
        for _ in range(ndup):
            cid, src = struct.unpack_from('<II', self.buf, at)
            at += 8
            self.aliases[cid] = src

    def static_ids(self):
        ids = sorted(set(self.statics) | set(self.aliases))
        return [i for i in ids if i != 0xffffffff]

    def blocks(self, static_id):
        """Yields each decompressed chunk of dynamic combos for a static combo."""
        static_id = self.aliases.get(static_id, static_id)
        at = self.statics[static_id]
        while True:
            head, = struct.unpack_from('<I', self.buf, at)
            at += 4
            if head == 0xffffffff:
                return
            size = head & 0x3fffffff
            kind = head >> 30
            data = self.buf[at:at + size]
            at += size
            yield data if kind == 2 else unlzma(data)

    def dynamics(self, static_id):
        """{dynamic combo id: bytecode}"""
        out = {}
        for block in self.blocks(static_id):
            at = 0
            while at + 8 <= len(block):
                cid, size = struct.unpack_from('<II', block, at)
                at += 8
                if cid == 0xffffffff:
                    break
                out[cid] = block[at:at + size]
                at += size
        return out


def unlzma(data):
    # Valve's wrapper: 'LZMA', actual size, compressed size, 5 property bytes, then the stream
    if data[:4] != b'LZMA':
        raise ValueError('unknown chunk: ' + data[:4].hex())
    actual, compressed = struct.unpack_from('<II', data, 4)
    alone = data[12:17] + struct.pack('<Q', actual) + data[17:17 + compressed]
    return lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(alone, actual)


def disassemble(code):
    d3d = ctypes.WinDLL('d3dcompiler_47.dll')
    blob = ctypes.c_void_p()
    if d3d.D3DDisassemble(code, ctypes.c_size_t(len(code)), 0, None, ctypes.byref(blob)):
        raise OSError('D3DDisassemble failed')
    vt = ctypes.cast(ctypes.cast(blob, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
    ptr = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(vt[3])(blob)
    size = ctypes.CFUNCTYPE(ctypes.c_size_t, ctypes.c_void_p)(vt[4])(blob)
    return ctypes.string_at(ptr, size).decode('latin1')


def main(argv):
    v = Vcs(argv[1])
    if len(argv) == 2:
        print(f'combos {v.total}, dynamic {v.dynamic}, static present {len(v.static_ids())}, aliases {len(v.aliases)}, flags {v.flags:#x}')
    elif argv[2] == '--list':
        print(*v.static_ids()[:int(argv[3]) if len(argv) > 3 else 64])
    else:
        d = v.dynamics(int(argv[2]))
        print(disassemble(d[int(argv[3]) if len(argv) > 3 else min(d)]))


if __name__ == '__main__':
    main(sys.argv)
