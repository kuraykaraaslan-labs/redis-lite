import BitmapsBitService from './bitmaps.bit.service';
import BitmapsFieldService from './bitmaps.field.service';
import BitmapsOpService from './bitmaps.op.service';
import BitmapStore from './bitmaps.structure';

export { BitmapsBitService, BitmapsFieldService, BitmapsOpService, BitmapStore };

/** The bitmaps module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class BitmapsService {
  // Store — the read step of read-first commands
  static read = BitmapStore.read.bind(BitmapStore);

  // Bits — GETBIT, SETBIT, BITCOUNT, BITPOS
  static getBit = BitmapsBitService.getBit.bind(BitmapsBitService);
  static setBit = BitmapsBitService.setBit.bind(BitmapsBitService);
  static bitCount = BitmapsBitService.bitCount.bind(BitmapsBitService);
  static bitPosEmpty = BitmapsBitService.bitPosEmpty.bind(BitmapsBitService);
  static bitPos = BitmapsBitService.bitPos.bind(BitmapsBitService);

  // BITOP
  static bitOp = BitmapsOpService.bitOp.bind(BitmapsOpService);

  // BITFIELD / BITFIELD_RO
  static bitfield = BitmapsFieldService.bitfield.bind(BitmapsFieldService);
}
