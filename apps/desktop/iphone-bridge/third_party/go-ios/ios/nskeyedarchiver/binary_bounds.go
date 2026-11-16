package nskeyedarchiver

import "encoding/binary"

// Validate container sizes and expansion before go-plist allocates or recurses.
func boundedBinaryPlist(data []byte) bool {
	if len(data) < 40 || len(data) > 16<<20 || string(data[:8]) != "bplist00" {
		return false
	}
	trailer := data[len(data)-32:]
	count := binary.BigEndian.Uint64(trailer[8:])
	top := binary.BigEndian.Uint64(trailer[16:])
	end := binary.BigEndian.Uint64(trailer[24:])
	size, ref := uint64(trailer[6]), uint64(trailer[7])
	if count == 0 || count > 100000 || top >= count || size < 1 || size > 8 || ref < 1 || ref > 8 || end < 8 || end > uint64(len(data)-32) || count > (uint64(len(data)-32)-end)/size {
		return false
	}
	number := func(b []byte) uint64 {
		var n uint64
		for _, x := range b {
			n = n<<8 | uint64(x)
		}
		return n
	}
	offsets := make([]uint64, count)
	for i := range offsets {
		position := end + uint64(i)*size
		offsets[i] = number(data[position : position+size])
		if offsets[i] < 8 || offsets[i] >= end {
			return false
		}
	}
	state := make([]uint8, count)
	heights := make([]int, count)
	weights := make([]int, count)
	var visit func(uint64, int) (int, int, bool)
	visit = func(id uint64, depth int) (int, int, bool) {
		if id >= count || depth > 64 || state[id] == 1 {
			return 0, 0, false
		}
		if state[id] == 2 {
			return heights[id], weights[id], depth+heights[id] <= 64
		}
		state[id] = 1
		position := offsets[id]
		tag := data[position]
		position++
		kind := tag >> 4
		length := uint64(tag & 15)
		width := uint64(1)
		container := false
		switch kind {
		case 0:
			if tag != 0 && tag != 8 && tag != 9 && tag != 15 {
				return 0, 0, false
			}
			length = 0
		case 1:
			if length > 4 {
				return 0, 0, false
			}
			length = 1 << length
		case 2:
			if length != 2 && length != 3 {
				return 0, 0, false
			}
			length = 1 << length
		case 3:
			if length != 3 {
				return 0, 0, false
			}
			length = 8
		case 8:
			if length > 7 {
				return 0, 0, false
			}
			length++
		case 4, 5, 6, 10, 13:
			if length == 15 {
				if position >= end || data[position]>>4 != 1 || data[position]&15 > 3 {
					return 0, 0, false
				}
				n := uint64(1) << (data[position] & 15)
				position++
				if n > end-position {
					return 0, 0, false
				}
				length = number(data[position : position+n])
				position += n
			}
			if kind == 6 {
				width = 2
			}
			if kind == 10 || kind == 13 {
				container = true
				width = ref
				if kind == 13 {
					width *= 2
				}
			}
		default:
			return 0, 0, false
		}
		if position > end || length > (end-position)/width {
			return 0, 0, false
		}
		height, weight := 0, 1
		if container {
			if length > 100000 {
				return 0, 0, false
			}
			edges := length
			if kind == 13 {
				edges *= 2
			}
			for i := uint64(0); i < edges; i++ {
				start := position + i*ref
				child := number(data[start : start+ref])
				h, w, ok := visit(child, depth+1)
				if !ok {
					return 0, 0, false
				}
				height = max(height, h+1)
				weight += w
				if weight > 200000 {
					return 0, 0, false
				}
			}
		}
		state[id] = 2
		heights[id] = height
		weights[id] = weight
		return height, weight, depth+height <= 64
	}
	_, _, ok := visit(top, 0)
	return ok
}
