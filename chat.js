const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const psl = require('psl');
const axios = require('axios');
const schedule = require('node-schedule');
const tuling123ApiUrl = 'http://openapi.tuling123.com/openapi/api/v2';
const tuling123ApiKeyArr = [
	'xxxxxxxxxxxxxxxxx' //你自己的图灵123ApiKey, 不要用我的^_^
	]
const tuling123ApiKey = ()=>{
	const len = tuling123ApiKeyArr.length;
	return tuling123ApiKeyArr[~~(Math.random()*len)]
};

// 每周一清空周榜
schedule.scheduleJob('59 59 23 * * 0', function(){
	clearDomainBillboard();
});

const server = new https.createServer({
	cert: fs.readFileSync('../xxxxxxxx/cert/xxxx.crt'), //你自己域名的SSL证书 ^_^
	key: fs.readFileSync('../xxxxxxxx/cert/xxxx.key') //你自己域名的SSL私钥 ^_^
});
const wss = new WebSocket.Server({ server });

function noop(){}

wss.on('connection', ws => {
	if(wss.clients.size>200){
		return ws.terminate();
	}
	ws.isAlive = 2;
	ws.id = Date.now();
	ws.name = genRandomName();
	ws.on('pong', () => (ws.isAlive = 2));
	ws.on('message', msg => onReceiveMessage(msg, ws));
});

server.listen(9001);

setInterval(() => {
	// console.log(Date.now(), 'clients:', wss.clients.size);
	broadcastMemberList();
	terminateDeadWs();
}, 15000);

let messageHistory=[];
readMessageHistory();

let domainBillboard=[];
readDomainBillboard();

function readMessageHistory(){
	let str;
	try {
		str = fs.readFileSync('./chat-history.txt').toString('utf-8') || '[]';
	} catch (e){
		str = '[]';
	}
	try {
		str = JSON.parse(str);
	} catch (e){
		str = [];
	}
	messageHistory = str;
}

function saveMessageHistory(){
	let str = JSON.stringify(messageHistory, null, 2);
	fs.writeFile('./chat-history.txt', str, ()=>{});
}

function readDomainBillboard(){
	let str;
	try {
		str = fs.readFileSync('./chat-domain.txt').toString('utf-8') || '[]';
	} catch (e){
		str = '[]';
	}
	try {
		str = JSON.parse(str);
	} catch (e){
		str = [];
	}
	domainBillboard = str;
}

function saveDomainBillboard(){
	let str = JSON.stringify(domainBillboard, null, 2);
	fs.writeFile('./chat-domain.txt', str, ()=>{});
}

function pushDomain(domainFrom){
	if(psl.parse(domainFrom).listed===false) return;
	let arr = domainBillboard;
	let item = arr.find(i=>i.domainFrom === domainFrom);
	if (!item){
		arr.push({
			domainFrom: domainFrom,
			times: 1
		});
	} else {
		item.times++;
	}
	saveDomainBillboard();
}

function loadDomainBillboard(){
	let arr = domainBillboard;
	arr.sort((i,j)=>(j.times-i.times));
	return arr.slice(0,3);
}

function clearDomainBillboard(){
	domainBillboard = [];
	saveDomainBillboard();
}

function getMemberList(){
	let arr = [];
	wss.clients.forEach(ws=>{
		arr.push({
			id: ws.id,
			name: ws.name
		})
	});
	return arr;
}

function broadcastMemberList(domainFrom=undefined){
	[...wss.clients].filter(i=>(!domainFrom || i.domainFrom===domainFrom))
	.forEach(ws => {
		if(ws.isAlive <= 0 || ws.readyState !== WebSocket.OPEN) return;
		let arr = getMemberListOfDomain(wss.clients, ws.domainFrom);
		let msg = {
			type: 'memberList',
			data: arr
		};
		ws.send(JSON.stringify(msg));
	});
	function getMemberListOfDomain(clients,domainFrom){
		let output = [...clients].filter(c=>c.domainFrom===domainFrom);
		output = output.map(c=>({
			id: c.id,
			name: c.name
		}));
		output.unshift({id: 12523461428, name:'小尬'});
		return output;
	}
}

function terminateDeadWs(){
	wss.clients.forEach(ws => {
		if (ws.isAlive <= 0) return ws.terminate();
		ws.isAlive --;
		ws.ping(noop);
	});
}

function onReceiveMessage(raw, ws){
	let id = ws.id;
	let domainFrom = ws.domainFrom;
	let name = ws.name;
	let json;
	try {
		json = JSON.parse(raw);
	} catch(e){
		json = {};
	}
	if(!json.data) return;
	json.data.id = id;
	json.data.name = name;
	if(json.type === 'chat'){
		if(!domainFrom) return;
		receiveChatMessage(json.data, ws);
	} else if(json.type === 'update'){
		updateUserInfo(json.data);
	}
}

function receiveChatMessage(data={}, ws){
	if(!data.msg) return;
	data.msg = data.msg.slice(0,50)
		.replace(/\</g, '&lt;')
		.replace(/\>/g, '&gt;')
		.replace(/\&/g, '&#38;')
		.replace(/\'/g, '&#x27;')
		.replace(/\"/g, '&quot;')
		.replace(/\n/g, ' ');
	logMessageHistory(data, ws.domainFrom);
	broadcastMessage(data, ws.domainFrom);
	ackSender(ws);
}

function logMessageHistory(data, domainFrom){
	data.domainFrom = domainFrom;
	data.time = Date.now();
	messageHistory.unshift(data);
	messageHistory.length = 300;
	saveMessageHistory();
}

function broadcastMessage(data, domainFrom){
	let members = [...wss.clients].filter(ws=>{
		if(ws.isAlive <= 0 || ws.readyState !== WebSocket.OPEN) return false;
		if(ws.domainFrom !== domainFrom) return false;
		return true;
	});
	members.forEach(ws => {
		let d = {
			type: 'chat',
			data: {
				time: Date.now(),
				id: data.id,
				name: data.name,
				msg: data.msg
			}
		}
		ws.send(JSON.stringify(d));
	});
	console.log(`from:${domainFrom}, users:${members.length}, total:${wss.clients.size}, ${data.msg}`);
	if(data.msg.includes('@小尬') && !data.robot){
		robotEcho(data, domainFrom);
	}
	if(members.length>1 && !data.robot){
		pushDomain(domainFrom);
	}
}

function ackSender(ws){
	let json = {
		type: 'ack',
		data: ''
	}
	if (ws.readyState !== WebSocket.OPEN) return;
	ws.send(JSON.stringify(json));
}

function robotEcho(data, domainFrom){
	(async function(){
		let msg = data.msg.replace(/@小尬/g, '').trim();
		msg.length === 0 ? msg = '我是新来的.' : null;
		let req = {
			"reqType": 0,
			"perception": {
				"inputText": {
					"text": msg
				}
			},
			"userInfo": {
				"apiKey": tuling123ApiKey(),
				"userId": ""+data.id
			}
		};
		let res = await axios.post(tuling123ApiUrl, req);
		res = res.data;
		if(!res || !res.intent || res.intent.code<=7002 || res.results.length===0) {
			res.apiKey = req.userInfo.apiKey;
			console.log(JSON.stringify(res, null, 2));
			return;
		}
		let results = res.results;
		let echo = results.reduce((acc,val)=>{
			if(val.groupType!==0 && val.groupType!==1) return acc;
			let resultType = val.resultType;
			if(resultType!=='text' && resultType!=='url' && resultType!=='news') return acc;
			if(resultType==='text'){
				return acc + val.values[resultType] + ' ';
			} else if (resultType==='url') {
				let url = val.values.url;
				return acc + `<a target="_blank" href="${url}" title="${url}">${url.length>20 ? url.slice(0,20)+'...' : url}</a> `
			} else {
				let url = val.values[resultType][0].detailurl;
				return acc + `<a target="_blank" href="${url}" title="${url}">${url.length>20 ? url.slice(0,20)+'...' : url}</a> `
			}
		},'')
		let json = {
			msg: `@${data.name} ${echo || '^-^'}`,
			time: Date.now(),
			id: 12523461428,
			name: '小尬',
			robot: true
		}
		setTimeout(()=>{
			broadcastMessage(json, domainFrom);
			logMessageHistory(json, domainFrom);
		}, 500);
	})();
}

function robotEchoOld(domainFrom){
	const echoList = ['你是GG还是MM？','呜呜呜，我好冷啊', '我是游荡在废弃聊天室的幽…啊不，精灵', '呜呜呜呜呜……', '呜呜呜…', '呜呜呜呜…', '这里似乎只有你一个人类哦', '这个聊天室曾经有很多人类…', '房间外面的世界，是怎样的？', '我已经忘了是从什么时候就在这里的', '我被人类遗忘了…'];
	let date = new Date();
	let hour = date.getHours();
	let minute = ''+date.getMinutes();
	minute = minute[0]===minute ? '0'+minute : minute;
	let str = `你好，人类，现在是${hour}点${minute}分`;
	if(hour<15) {
		str+='，一天顺利哦~';
	} else {
		str+='，一天顺利吗？';
	}
	echoList.push(str);
	let json = {};
	json.msg = echoList[~~(Math.random()*echoList.length)];
	json.time = +date;
	json.id = 230230231210;
	json.name = '　';
	json.robot = true;
	setTimeout(()=>{
		broadcastMessage(json, domainFrom);
	}, 1900);
}

function updateUserInfo(data){
	let ws = [...wss.clients].find(ws=>ws.id===data.id);
	// ws.name = (data.name || ws.name || '').slice(0,12);
	let domain;
	if(!ws.domainFrom && data.domainFrom){
		domain = psl.parse(data.domainFrom).domain || '';
		ws.domainFrom = domain;
	}
	if(ws.readyState !== WebSocket.OPEN) return;
	let json = {
		type: "identity",
		data: {
			id: data.id,
			name: ws.name,
			domain: domain,
			history: loadMessageHistory(domain),
			billboard: loadDomainBillboard()
		}
	}
	ws.send(JSON.stringify(json));
	ws.domainFrom && broadcastMemberList(domain);
}

function loadMessageHistory(domain){
	let len = messageHistory.length;
	let arr = [];
	for(let i=0; i<len && arr.length<10; i++){
		let item = messageHistory[i];
		if(!item) break;
		if(item.domainFrom===domain){
			arr.unshift(messageHistory[i]);
		}
	}
	return arr.map(i=>({
		id: i.id,
		name: i.name,
		time: i.time,
		msg: i.msg
	}));
}

const name1Arr = ['秋','假面','独行','涼城孤島','最后','孤独','靈魂','烂漫','冷漠','槑','丿巅峰','薰铱草','迣鎅','箪纯','依心而行','无泪','唯爱','超萌系','烟瘾','凋谢','沉溺','缠绵','落荒而逃','天涯','倾城','相贱恨晚','霸道','花下','停留','深情','断桥','滾','爺','私念','加载中','认命','樱雨','花嫁','天国','时光','高傲','限量版','陌上','浅语','伱','莪','往昔','阴霾','草泥马','墨迹','焚心','柠檬树下','那年','奮鬥','重命名','相思','葬訫','婲訫','疯狂','丅一站','堅強','微凉','盛夏','放肆','忧伤','夏末','转身','該死','称霸','瘋癲','虛构','天然呆','凌乱','小唯美','生锈','刺心','梦醒','嫑忐','卟㊣常','堇色','素颜','擱淺','斷誸','飞翔','霸气','雲端','蕾丝','繁華','45°','绯色','淺笑','夢中','葬爱','鬼魅','丿孑然','狠拽','虛僞','忧伤','髙尚','蕗鐹','闷骚','卟妥','浅Sé','弑愛','扭麯','埘绱'];
const name2Arr = ['','→','↗','↘','、','﹏','丶','的','の','…','，','oO','ゞ','ゝ','▍','┆','de','Dē','Dé','№','嘚','∞','灬','〆','°','丿','あ','ぴ','ミ','ㄨ','※','♂','♀','ゆ','∮','ぃ','℅'];
const name3Arr = ['蒾伱裙','行者','旅行者','悸动','少年','老衲','神','王','太阳','朕','逗逼','第三者','萢萢','疯孓','殇ペ','蒲公英','記憶','涳心人','玻璃心','男人','女人','沫子','尐幸福','龍少','浅笑','王子','态度','受伤','尛糖豆','尐脚丫','苯尒孩','禽兽','情蛊','菠萝蜜','浪子','好人','貓咪','脾氣','筱猪','黛顏','喵星人','覀苽','寳寳','女王','皇朝','灭婊','GIRl','囄開','痞子','长裙','青春つ','流星','雨朦朦','天空','欲望','流氓','拥抱','残梦゛','烟花べ','嘟嘟','帅哥','少爷','总裁','朩頭亾','思念ミ','小情绪ぃ','诱惑','路人甲','鸢蝶','小妞','蟲児','花痴','回忆','毒藥','钕亽','琉璃','Angel','寒风','尛酒窩','尐豬','心跳╯','べ痛','尐囝','摯愛','孩子','浪花°','尛尛','い风','KISS','天使','花落','釋懷','裤头','ポ偶亼','余溫','落葉','じ★ve','錵朶','淚珠','深瞳','凝眸','尐姐丶','^-^','七寶','小葉','咖啡','黑眼圈','紸埆','婲'];

function genRandomName(){
	const len1 = name1Arr.length;
	const len2 = name2Arr.length;
	const len3 = name3Arr.length;
	name1 = name1Arr[~~(Math.random()*len1)];
	name2 = name2Arr[~~(Math.random()*len2)];
	name3 = name3Arr[~~(Math.random()*len3)];
	return name1+name2+name3;
}