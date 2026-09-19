export type SceneArt =
  | "palace"
  | "wall"
  | "garden"
  | "architecture"
  | "city"
  | "coast"
  | "ancient-city"
  | "grotto"
  | "grassland"
  | "desert"
  | "volcano"
  | "lake"
  | "snow"
  | "watertown"
  | "mountain"
  | "temple"
  | "island"
  | "tulou"
  | "canyon"
  | "forest"
  | "peakforest"
  | "danxia"
  | "karst"
  | "terrace"
  | "bay"
  | "waterfall"
  | "history"
  | "saltlake"
  | "harbour";

export type SceneDestination = {
  id: string;
  name: string;
  region: string;
  summary: string;
  scene: string;
  accent: string;
  tags: string[];
  art: SceneArt;
  latitude?: number;
  longitude?: number;
};

const accents: Partial<Record<SceneArt, string>> = {
  palace: "#9b5c43",
  wall: "#7d6e54",
  garden: "#60775d",
  architecture: "#8a6654",
  city: "#4f7891",
  coast: "#2f8295",
  "ancient-city": "#8b704d",
  grotto: "#8b725b",
  grassland: "#648b5f",
  desert: "#b77a42",
  volcano: "#65849a",
  lake: "#337da4",
  snow: "#688ba5",
  watertown: "#3f7770",
  mountain: "#45695d",
  temple: "#8a6848",
  island: "#317f8f",
  tulou: "#8d694e",
  canyon: "#8c705f",
  forest: "#577c61",
  peakforest: "#546b60",
  danxia: "#b45f48",
  karst: "#4b8077",
  terrace: "#8a7d4a",
  bay: "#3b829a",
  waterfall: "#3a8796",
  history: "#8a6449",
  saltlake: "#5e8fa8",
  harbour: "#3d7891",
};

function d(id: string, name: string, region: string, art: SceneArt, tags: string): SceneDestination {
  const tagList = tags.split("|").filter(Boolean);
  return {
    id,
    name,
    region,
    summary: tagList.join("、"),
    scene: `/scenes/inspirations/${id}.svg`,
    accent: accents[art] ?? "#45695d",
    tags: tagList,
    art,
  };
}

export const sceneDestinations: SceneDestination[] = [
  d("forbidden-city", "故宫", "北京", "palace", "宫殿|历史|建筑"),
  d("great-wall", "八达岭长城", "北京", "wall", "长城|山脊|历史"),
  d("summer-palace", "颐和园", "北京", "garden", "皇家园林|湖景|建筑"),

  d("fifth-avenue", "五大道", "天津", "architecture", "洋楼|街区|人文"),
  d("tianjin-eye", "天津之眼", "天津", "city", "海河|夜景|城市"),

  d("chengde-resort", "承德避暑山庄", "河北", "garden", "皇家园林|山水|历史"),
  d("beidaihe", "北戴河", "河北", "coast", "海滨|日出|沙滩"),

  d("pingyao", "平遥古城", "山西", "ancient-city", "古城|票号|街巷"),
  d("yungang", "云冈石窟", "山西", "grotto", "石窟|佛像|历史"),

  d("hulunbuir", "呼伦贝尔草原", "内蒙古", "grassland", "草原|牧场|公路"),
  d("kubuqi", "库布其沙漠", "内蒙古", "desert", "沙漠|星空|越野"),

  d("dalian-coast", "大连滨海路", "辽宁", "coast", "海岸|公路|日落"),
  d("shenyang-palace", "沈阳故宫", "辽宁", "palace", "宫殿|满族|历史"),

  d("changbaishan", "长白山", "吉林", "volcano", "天池|瀑布|森林"),
  d("songhua-lake", "松花湖", "吉林", "lake", "湖景|群山|游船"),

  d("snow-town", "中国雪乡", "黑龙江", "snow", "雪村|木屋|冬景"),
  d("wudalianchi", "五大连池", "黑龙江", "lake", "火山|湖泊|地质"),

  d("the-bund", "上海外滩", "上海", "city", "天际线|江景|夜景"),
  d("yu-garden", "豫园", "上海", "garden", "园林|老城|市井"),

  d("suzhou-garden", "苏州园林", "江苏", "garden", "园林|亭台|曲水"),
  d("zhouzhuang", "周庄", "江苏", "watertown", "水巷|拱桥|古镇"),
  d("jiangnan", "江南水乡", "江苏 / 浙江", "watertown", "水乡|古镇|园林"),
  d("nanjing-qinhuai", "南京秦淮河", "江苏", "city", "河畔|灯火|古城"),

  d("west-lake", "杭州西湖", "浙江", "lake", "湖景|苏堤|四季"),
  d("wuzhen", "乌镇", "浙江", "watertown", "水乡|夜游|古镇"),
  d("yandang", "雁荡山", "浙江", "mountain", "奇峰|飞瀑|夜游"),

  d("huangshan", "黄山", "安徽", "mountain", "奇峰|云海|迎客松"),
  d("hongcun", "宏村", "安徽", "watertown", "月沼|徽派|古村"),
  d("jiuhuashan", "九华山", "安徽", "temple", "山寺|云海|祈福"),

  d("gulangyu", "厦门鼓浪屿", "福建", "island", "海岛|建筑|日落"),
  d("wuyi-mountain", "武夷山", "福建", "mountain", "丹霞|九曲溪|茶山"),
  d("fujian-tulou", "福建土楼", "福建", "tulou", "土楼|客家|山乡"),

  d("lushan", "庐山", "江西", "mountain", "云雾|瀑布|别墅"),
  d("wuyuan", "婺源", "江西", "watertown", "油菜花|徽村|田园"),

  d("taishan", "泰山", "山东", "mountain", "日出|石刻|登山"),
  d("qingdao-coast", "青岛海滨", "山东", "coast", "海湾|红瓦|啤酒"),
  d("qufu", "曲阜三孔", "山东", "temple", "儒学|古建|人文"),

  d("longmen-grottoes", "龙门石窟", "河南", "grotto", "石窟|伊河|佛像"),
  d("shaolin-temple", "少林寺", "河南", "temple", "功夫|古刹|嵩山"),
  d("yuntai-mountain", "云台山", "河南", "canyon", "峡谷|瀑布|红岩"),

  d("shennongjia", "神农架", "湖北", "forest", "原始森林|云海|秘境"),
  d("wudang-mountain", "武当山", "湖北", "temple", "道观|金顶|云海"),
  d("enshi-canyon", "恩施大峡谷", "湖北", "canyon", "峡谷|绝壁|地缝"),

  d("zhangjiajie", "张家界", "湖南", "peakforest", "峰林|峡谷|徒步"),
  d("fenghuang", "凤凰古城", "湖南", "ancient-city", "吊脚楼|沱江|夜景"),
  d("hengshan", "南岳衡山", "湖南", "mountain", "云海|古寺|日出"),

  d("canton-tower", "广州塔", "广东", "city", "城市|夜景|珠江"),
  d("kaiping-diaolou", "开平碉楼", "广东", "tulou", "碉楼|侨乡|田园"),
  d("danxia-mountain", "丹霞山", "广东", "danxia", "丹霞|奇峰|徒步"),

  d("guilin", "桂林阳朔", "广西", "karst", "喀斯特|漓江|竹筏"),
  d("longji-terraces", "龙脊梯田", "广西", "terrace", "梯田|瑶寨|云海"),
  d("weizhou-island", "涠洲岛", "广西", "island", "海岛|火山|日落"),

  d("sanya", "三亚海湾", "海南", "coast", "海岛|椰林|沙滩"),
  d("wuzhizhou", "蜈支洲岛", "海南", "island", "浮潜|海岛|碧海"),
  d("luhuitou", "鹿回头", "海南", "bay", "海湾|夜景|日落"),

  d("hongya-cave", "洪崖洞", "重庆", "city", "吊脚楼|夜景|江畔"),
  d("wulong-karst", "武隆喀斯特", "重庆", "karst", "天生桥|峡谷|溶洞"),
  d("dazu-rock-carvings", "大足石刻", "重庆", "grotto", "石刻|佛教|历史"),

  d("jiuzhaigou", "九寨沟", "四川", "lake", "彩林|海子|瀑布"),
  d("huanglong", "黄龙", "四川", "waterfall", "钙华池|雪山|瀑布"),
  d("emeishan", "峨眉山", "四川", "snow", "金顶|云海|雪景"),

  d("huangguoshu", "黄果树瀑布", "贵州", "waterfall", "瀑布|水雾|峡谷"),
  d("libo-xiaoqikong", "荔波小七孔", "贵州", "forest", "碧水|森林|古桥"),
  d("xijiang-miao", "西江千户苗寨", "贵州", "watertown", "苗寨|吊脚楼|夜景"),

  d("yulong-snow-mountain", "玉龙雪山", "云南", "snow", "雪山|蓝月谷|高原"),
  d("erhai-lake", "大理洱海", "云南", "lake", "洱海|苍山|骑行"),
  d("yuanyang-terraces", "元阳梯田", "云南", "terrace", "梯田|云海|日出"),

  d("potala-palace", "布达拉宫", "西藏", "palace", "宫殿|高原|信仰"),
  d("namtso", "纳木错", "西藏", "lake", "圣湖|雪山|星空"),

  d("terracotta-army", "秦始皇兵马俑", "陕西", "history", "秦俑|历史|考古"),
  d("huashan", "华山", "陕西", "mountain", "险峰|栈道|日出"),
  d("xian-city-wall", "西安城墙", "陕西", "wall", "古城墙|骑行|夜色"),

  d("mogao-caves", "莫高窟", "甘肃", "grotto", "壁画|石窟|丝路"),
  d("zhangye-danxia", "张掖丹霞", "甘肃", "danxia", "丹霞|彩色丘陵|日落"),
  d("dunhuang-dunes", "敦煌鸣沙山", "甘肃", "desert", "沙丘|月牙泉|驼队"),

  d("qinghai-lake", "青海湖", "青海", "lake", "湖泊|油菜花|公路"),
  d("chaka-salt-lake", "茶卡盐湖", "青海", "saltlake", "盐湖|倒影|小火车"),
  d("qilian-mountains", "祁连山", "青海", "mountain", "草原|雪山|公路"),

  d("shapotou", "沙坡头", "宁夏", "desert", "沙漠|黄河|滑沙"),
  d("western-xia-tombs", "西夏王陵", "宁夏", "history", "陵墓|荒漠|历史"),

  d("kanas", "喀纳斯", "新疆", "lake", "湖泊|森林|秋色"),
  d("sayram-lake", "赛里木湖", "新疆", "lake", "高原湖|雪山|花海"),
  d("kashgar-old-city", "喀什古城", "新疆", "ancient-city", "老城|巴扎|人文"),

  d("victoria-peak", "太平山顶", "香港", "city", "城市|夜景|海湾"),
  d("tsim-sha-tsui", "尖沙咀海滨", "香港", "harbour", "维港|天际线|夜景"),

  d("ruins-st-pauls", "大三巴牌坊", "澳门", "architecture", "历史建筑|街区|人文"),
  d("taipa-village", "氹仔旧城区", "澳门", "city", "葡韵|街巷|美食"),

  d("sun-moon-lake", "日月潭", "台湾", "lake", "湖泊|群山|骑行"),
  d("alishan", "阿里山", "台湾", "mountain", "云海|森林|日出"),
  d("tiananmen-square", "天安门广场", "北京", "city", "地标|广场|历史"),
  d("temple-of-heaven", "天坛", "北京", "temple", "祭天|古建|历史"),
  d("beihai-park", "北海公园", "北京", "garden", "白塔|湖景|园林"),

  d("ancient-culture-street", "天津古文化街", "天津", "ancient-city", "老街|非遗|市井"),
  d("huangyaguan-wall", "黄崖关长城", "天津", "wall", "长城|山关|徒步"),

  d("baiyangdian", "白洋淀", "河北", "lake", "芦苇|水乡|荷塘"),
  d("yesanpo", "野三坡", "河北", "canyon", "峡谷|山水|漂流"),

  d("wutai-mountain", "五台山", "山西", "temple", "古寺|佛教|山岳"),
  d("hukou-waterfall", "壶口瀑布", "山西", "waterfall", "黄河|瀑布|峡谷"),

  d("xiangshawan", "响沙湾", "内蒙古", "desert", "沙漠|滑沙|驼队"),
  d("arxan", "阿尔山", "内蒙古", "forest", "森林|温泉|雪山"),

  d("laohutan", "老虎滩海洋公园", "辽宁", "coast", "海洋|海湾|亲子"),
  d("jinshitan", "金石滩", "辽宁", "island", "海岸|奇石|度假"),

  d("jingyuetan", "净月潭", "吉林", "forest", "森林|湖泊|骑行"),
  d("rime-island", "雾凇岛", "吉林", "snow", "雾凇|江畔|冬景"),

  d("sun-island", "太阳岛", "黑龙江", "lake", "湿地|园林|雪景"),
  d("arctic-village", "北极村", "黑龙江", "snow", "极光|雪村|北境"),

  d("shanghai-disney", "上海迪士尼", "上海", "city", "乐园|亲子|夜景"),
  d("zhujiajiao", "朱家角", "上海", "watertown", "水巷|石桥|古镇"),

  d("sun-yat-sen-mausoleum", "中山陵", "江苏", "history", "建筑|山林|历史"),
  d("slender-west-lake", "瘦西湖", "江苏", "lake", "湖景|园林|扬州"),
  d("xitang", "西塘古镇", "江苏", "watertown", "廊棚|水巷|夜色"),

  d("putuo-mountain", "普陀山", "浙江", "temple", "海岛|古寺|观音"),
  d("moganshan", "莫干山", "浙江", "forest", "竹海|山居|清凉"),
  d("shenxianju", "神仙居", "浙江", "mountain", "奇峰|云海|悬桥"),

  d("tianzhu-mountain", "天柱山", "安徽", "mountain", "奇峰|云海|石刻"),
  d("xidi", "西递", "安徽", "ancient-city", "徽派|古巷|牌坊"),
  d("xin-an-river", "新安江山水画廊", "安徽", "lake", "江水|徽村|画廊"),

  d("pingtan-island", "平潭岛", "福建", "island", "海岛|蓝眼泪|风车"),
  d("taimu-mountain", "太姥山", "福建", "mountain", "花岗岩|云雾|海景"),
  d("quanzhou-old-city", "泉州古城", "福建", "ancient-city", "古街|海丝|人文"),

  d("sanqingshan", "三清山", "江西", "mountain", "花岗岩|云海|栈道"),
  d("tengwang-pavilion", "滕王阁", "江西", "ancient-city", "楼阁|江景|人文"),
  d("wugong-mountain", "武功山", "江西", "grassland", "高山草甸|帐篷|云海"),

  d("penglai-pavilion", "蓬莱阁", "山东", "ancient-city", "海市蜃楼|古建|海岸"),
  d("rongcheng-swan-lake", "荣成天鹅湖", "山东", "lake", "天鹅|湿地|海湾"),
  d("taierzhuang", "台儿庄古城", "山东", "watertown", "运河|古城|夜景"),

  d("qingming-riverside-garden", "开封清明上河园", "河南", "ancient-city", "宋韵|水街|夜游"),
  d("baiyun-mountain", "洛阳白云山", "河南", "mountain", "森林|云海|瀑布"),
  d("hongqi-canal", "红旗渠", "河南", "canyon", "太行|人工天河|历史"),

  d("yellow-crane-tower", "黄鹤楼", "湖北", "ancient-city", "长江|名楼|夜景"),
  d("three-gorges-dam", "三峡大坝", "湖北", "city", "长江|工程|峡谷"),
  d("danjiangkou", "丹江口水库", "湖北", "lake", "水库|群山|清波"),

  d("dongjiang-lake", "东江湖", "湖南", "lake", "雾漫|湖景|游船"),
  d("furong-town", "芙蓉镇", "湖南", "watertown", "瀑布|土家|古镇"),
  d("orange-isle", "长沙橘子洲", "湖南", "city", "江洲|焰火|城市"),

  d("chimelong", "广州长隆", "广东", "city", "乐园|亲子|动物"),
  d("shantou-nanao-island", "汕头南澳岛", "广东", "island", "海岛|灯塔|环岛路"),

  d("detian-waterfall", "德天瀑布", "广西", "waterfall", "瀑布|边境|峡谷"),
  d("beihai-silver-beach", "北海银滩", "广西", "coast", "海滩|日落|度假"),
  d("huangyao-ancient-town", "黄姚古镇", "广西", "ancient-city", "青石板|古桥|田园"),

  d("yalong-bay", "亚龙湾", "海南", "bay", "海湾|椰林|度假"),
  d("wenchang-coconut-forest", "文昌椰子大观园", "海南", "forest", "椰林|田园|海风"),
  d("haikou-arcade-street", "海口骑楼老街", "海南", "architecture", "骑楼|老街|南洋"),

  d("three-gorges-summit", "三峡之巅", "重庆", "canyon", "长江|夔门|云海"),
  d("jinfo-mountain", "金佛山", "重庆", "snow", "雪景|喀斯特|古佛洞"),
  d("youyang-taohuayuan", "酉阳桃花源", "重庆", "forest", "桃源|溶洞|田园"),

  d("qingcheng-mountain", "青城山", "四川", "forest", "道教|山林|幽静"),
  d("dujiangyan", "都江堰", "四川", "history", "水利|古堰|青城"),
  d("leshan-buddha", "乐山大佛", "四川", "grotto", "大佛|江崖|石刻"),
  d("siguniang-mountain", "四姑娘山", "四川", "snow", "雪山|峡谷|徒步"),
  d("hailuogou", "海螺沟", "四川", "snow", "冰川|温泉|雪山"),

  d("zhenyuan-ancient-town", "镇远古镇", "贵州", "watertown", "㵲阳河|古城|夜色"),
  d("chishui-waterfall", "赤水大瀑布", "贵州", "waterfall", "丹霞|瀑布|竹海"),
  d("zhijin-cave", "织金洞", "贵州", "grotto", "溶洞|钟乳石|地下厅"),
  d("wanfenglin", "万峰林", "贵州", "peakforest", "峰林|田园|骑行"),

  d("lugu-lake", "泸沽湖", "云南", "lake", "高原湖|猪槽船|女儿国"),
  d("dali-old-town", "大理古城", "云南", "ancient-city", "古城|苍山|洱海"),
  d("xishuangbanna-rainforest", "西双版纳雨林", "云南", "forest", "雨林|傣族|热带"),
  d("tengchong-volcano", "腾冲火山", "云南", "volcano", "火山|温泉|银杏"),
  d("puzhehei", "普者黑", "云南", "watertown", "荷花|湖泊|山水"),

  d("basum-lake", "巴松措", "西藏", "lake", "圣湖|森林|雪山"),
  d("everest-base-camp", "珠峰大本营", "西藏", "snow", "珠峰|星空|高原"),
  d("yarlung-tsangpo-canyon", "雅鲁藏布大峡谷", "西藏", "canyon", "峡谷|雪山|江水"),

  d("shaanxi-hukou", "壶口瀑布陕西侧", "陕西", "waterfall", "黄河|瀑布|峡谷"),
  d("yanan-pagoda", "延安宝塔山", "陕西", "history", "宝塔|红色文化|山城"),
  d("qianling", "乾陵", "陕西", "history", "唐陵|石刻|历史"),
  d("taibai-mountain", "太白山", "陕西", "snow", "雪山|森林|云海"),

  d("jiayuguan-pass", "嘉峪关", "甘肃", "wall", "关城|长城|丝路"),
  d("labrang-monastery", "拉卜楞寺", "甘肃", "temple", "藏传佛教|古寺|草原"),
  d("kongtong-mountain", "崆峒山", "甘肃", "mountain", "道观|奇峰|云海"),
  d("maijishan", "麦积山", "甘肃", "grotto", "石窟|泥塑|悬崖"),

  d("mengda-tianchi", "孟达天池", "青海", "lake", "森林|天池|高原"),
  d("kumbum-monastery", "塔尔寺", "青海", "temple", "藏传佛教|酥油花|古寺"),
  d("hoh-xil", "可可西里", "青海", "grassland", "无人区|藏羚羊|荒野"),

  d("helan-mountains", "贺兰山", "宁夏", "mountain", "岩画|峡谷|葡萄酒"),
  d("zhenbeibao", "镇北堡西部影城", "宁夏", "architecture", "影城|荒漠|古镇"),
  d("shahu", "沙湖", "宁夏", "lake", "湖泊|沙漠|芦苇"),

  d("nalati", "那拉提草原", "新疆", "grassland", "草原|河谷|牧场"),
  d("bayinbuluke", "巴音布鲁克", "新疆", "grassland", "天鹅湖|九曲十八弯|草原"),
  d("karakul-lake", "喀拉库勒湖", "新疆", "lake", "高原湖|雪山|倒影"),
  d("duku-highway", "独库公路", "新疆", "grassland", "公路|雪山|峡谷"),
  d("flaming-mountains", "火焰山", "新疆", "desert", "红岩|高温|西游"),

  d("hong-kong-disney", "香港迪士尼", "香港", "city", "乐园|亲子|夜景"),
  d("ocean-park", "香港海洋公园", "香港", "coast", "海洋|缆车|亲子"),
  d("ngong-ping-buddha", "昂坪大佛", "香港", "temple", "大佛|缆车|山景"),

  d("venetian-macau", "澳门威尼斯人", "澳门", "city", "度假|建筑|夜景"),
  d("guia-fortress", "东望洋灯塔", "澳门", "harbour", "灯塔|城市|海景"),

  d("taroko-gorge", "太鲁阁峡谷", "台湾", "canyon", "峡谷|大理石|步道"),
  d("yehliu-geopark", "野柳地质公园", "台湾", "coast", "奇岩|海岸|女王头"),
  d("kenting", "垦丁", "台湾", "coast", "海岛|灯塔|沙滩"),
  d("jiufen", "九份", "台湾", "ancient-city", "山城|老街|夜景"),
];



