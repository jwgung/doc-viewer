"""rhwp wasm에서 앱이 쓰지 않는 API를 지운다(A5, 보기 전용으로 줄이기).

rhwp는 편집·내보내기·서명까지 HwpDocument 한 클래스로 내보내므로 링커가 안 쓰는 코드를 지우지 못한다.
wasm의 내보내기(export) 목록에서 앱이 부르는 메서드만 남기고, wasm-opt로 닿지 않는 코드를 지운다.
JS 글루(rhwp.js)는 그대로 둔다. 목록 밖의 메서드를 부르면 'wasm.xxx is not a function'으로 실패하므로,
hwp-worker.js에서 새 메서드를 쓰려면 KEEP에 더하고 다시 만든다.

사용: python3 -I scripts/slim-rhwp.py <원본 rhwp_bg.wasm> <출력 wasm> [wasm-opt 경로]
  wasm-opt는 binaryen 117 이상(wasm-pack이 ~/.cache/.wasm-pack/wasm-opt-*/bin/에 받아 둔다).
"""
import subprocess
import sys

# hwp-worker.js가 쓰는 메서드(wasm 내보내기 이름). wasm-bindgen 내부('__'로 시작)와 memory는 늘 남긴다.
KEEP = {
    "hwpdocument_new",
    "hwpdocument_openWithPassword",
    "hwpdocument_pageCount",
    "hwpdocument_getPageInfo",
    "hwpdocument_renderPageSvg",
    "hwpdocument_getPageTextLayout",
    "hwpdocument_getOutlineNavigation",
    "init_panic_hook",
}


def read_leb(data, pos):
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def leb(n):
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def keep_exports(data):
    """내보내기 구역(id 7)에서 남길 항목만 남긴 wasm 바이트와 (전체, 남긴) 개수를 돌려준다."""
    assert data[:4] == b"\0asm", "wasm 파일이 아닙니다"
    out = bytearray(data[:8])
    pos = 8
    total = kept_count = 0
    while pos < len(data):
        section_id = data[pos]
        size, body = read_leb(data, pos + 1)
        end = body + size
        if section_id != 7:
            out += data[pos:end]
            pos = end
            continue
        count, p = read_leb(data, body)
        kept = []
        for _ in range(count):
            start = p
            name_length, p = read_leb(data, p)
            name = data[p:p + name_length].decode()
            p += name_length + 1  # 이름 뒤 종류(1바이트)
            _, p = read_leb(data, p)  # 색인
            total += 1
            if name == "memory" or name.startswith("__") or name in KEEP:
                kept.append(data[start:p])
        kept_count = len(kept)
        section = leb(len(kept)) + b"".join(kept)
        out += bytes([7]) + leb(len(section)) + section
        pos = end
    return bytes(out), total, kept_count


def main():
    source, target = sys.argv[1], sys.argv[2]
    wasm_opt = sys.argv[3] if len(sys.argv) > 3 else "wasm-opt"
    data, total, kept = keep_exports(open(source, "rb").read())
    trimmed = target + ".exports.wasm"
    open(trimmed, "wb").write(data)
    # -all: wasm-bindgen 산출물이 쓰는 기능(참조 형식 등)을 모두 켠다. -Oz: 크기 우선 최적화(닿지 않는 코드 제거 포함).
    subprocess.run([wasm_opt, "-all", "-Oz", trimmed, "-o", target], check=True)
    print(f"내보내기 {total}개 중 {kept}개 남김 → {target}")


if __name__ == "__main__":
    main()
