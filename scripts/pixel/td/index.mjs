// The top-down court scenes (one module per hall). Each returns { bg: Bitmap(1280×720), spots }.
import { taihe } from './taihe.mjs';
import { guangchang } from './guangchang.mjs';
import { chengtian } from './chengtian.mjs';
import { junjichu } from './junjichu.mjs';
import { liubu } from './liubu.mjs';
import { donggong } from './donggong.mjs';
import { yuhuayuan } from './yuhuayuan.mjs';
import { gongdao } from './gongdao.mjs';
import { jiaolou } from './jiaolou.mjs';
import { yutu } from './yutu.mjs';

export function buildTopDown() {
  return { taihe: taihe(), guangchang: guangchang(), chengtian: chengtian(), junjichu: junjichu(), liubu: liubu(), donggong: donggong(), yuhuayuan: yuhuayuan(), gongdao: gongdao(), jiaolou: jiaolou(), yutu: yutu() };
}
