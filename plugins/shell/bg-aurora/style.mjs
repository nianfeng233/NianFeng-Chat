/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** bg-aurora 样式：demo 的浅绿光团动画 */
export const AURORA_CSS = `
  .bg-layer{position:fixed;inset:0;z-index:-1;pointer-events:none;}

  .bg-aurora{
    position:absolute;inset:0;overflow:hidden;
    pointer-events:none;background:#ffffff;
  }
  .blob{
    position:absolute;border-radius:50%;
    filter:blur(60px);
    will-change:transform;
    transform-origin:center center;
    top:0; left:0;
  }
  .b1{ width:70vmax;height:70vmax;margin-left:-30vmax;margin-top:-30vmax;
    background:radial-gradient(circle at 50% 50%,rgba(184,228,150,.42) 0%,rgba(184,228,150,.24) 30%,rgba(184,228,150,.08) 55%,rgba(184,228,150,0) 72%);
    animation:drift1 34s linear infinite; }
  .b2{ width:55vmax;height:55vmax;margin-left:-27vmax;margin-top:-27vmax;
    background:radial-gradient(circle at 50% 50%,rgba(212,240,182,.40) 0%,rgba(212,240,182,.20) 32%,rgba(212,240,182,.06) 58%,rgba(212,240,182,0) 74%);
    animation:drift2 27s linear infinite;animation-delay:-6s; }
  .b3{ width:45vmax;height:45vmax;margin-left:-22vmax;margin-top:-22vmax;
    background:radial-gradient(circle at 50% 50%,rgba(222,244,196,.36) 0%,rgba(222,244,196,.18) 34%,rgba(222,244,196,.05) 58%,rgba(222,244,196,0) 74%);
    animation:drift3 40s linear infinite;animation-delay:-14s; }
  .b4{ width:72vmax;height:72vmax;margin-left:-36vmax;margin-top:-36vmax;
    background:radial-gradient(circle at 50% 50%,rgba(170,220,140,.40) 0%,rgba(170,220,140,.22) 30%,rgba(170,220,140,.07) 55%,rgba(170,220,140,0) 72%);
    animation:drift4 31s linear infinite;animation-delay:-19s; }
  .b5{ width:58vmax;height:58vmax;margin-left:-29vmax;margin-top:-29vmax;
    background:radial-gradient(circle at 50% 50%,rgba(196,232,164,.38) 0%,rgba(196,232,164,.20) 32%,rgba(196,232,164,.06) 56%,rgba(196,232,164,0) 72%);
    animation:drift5 37s linear infinite;animation-delay:-10s; }
  .b6{ width:40vmax;height:40vmax;margin-left:-20vmax;margin-top:-20vmax;
    background:radial-gradient(circle at 50% 50%,rgba(230,248,206,.46) 0%,rgba(230,248,206,.24) 32%,rgba(230,248,206,.06) 58%,rgba(230,248,206,0) 74%);
    animation:drift6 24s linear infinite;animation-delay:-3s; }
  .b7{ width:42vmax;height:42vmax;margin-left:-21vmax;margin-top:-21vmax;
    background:radial-gradient(circle at 50% 50%,rgba(190,230,152,.40) 0%,rgba(190,230,152,.22) 32%,rgba(190,230,152,.06) 58%,rgba(190,230,152,0) 74%);
    animation:drift7 29s linear infinite;animation-delay:-16s; }
  .b8{ width:48vmax;height:48vmax;margin-left:-24vmax;margin-top:-24vmax;
    background:radial-gradient(circle at 50% 50%,rgba(216,242,184,.38) 0%,rgba(216,242,184,.20) 34%,rgba(216,242,184,.05) 58%,rgba(216,242,184,0) 74%);
    animation:drift8 22s linear infinite;animation-delay:-8s; }

  @keyframes drift1{
    0%{transform:translate3d(18vw,18vh,0) scale(1)}14%{transform:translate3d(38vw,32vh,0) scale(1.38)}
    28%{transform:translate3d(60vw,52vh,0) scale(.82)}43%{transform:translate3d(72vw,78vh,0) scale(1.28)}
    57%{transform:translate3d(48vw,88vh,0) scale(.72)}71%{transform:translate3d(22vw,70vh,0) scale(1.22)}
    85%{transform:translate3d(8vw,42vh,0) scale(.92)}100%{transform:translate3d(18vw,18vh,0) scale(1)}}
  @keyframes drift2{
    0%{transform:translate3d(82vw,22vh,0) scale(1.1)}16%{transform:translate3d(58vw,38vh,0) scale(.78)}
    32%{transform:translate3d(42vw,62vh,0) scale(1.32)}48%{transform:translate3d(58vw,84vh,0) scale(.88)}
    64%{transform:translate3d(86vw,72vh,0) scale(1.26)}82%{transform:translate3d(90vw,46vh,0) scale(.95)}
    100%{transform:translate3d(82vw,22vh,0) scale(1.1)}}
  @keyframes drift3{
    0%{transform:translate3d(48vw,42vh,0) scale(1)}18%{transform:translate3d(68vw,30vh,0) scale(1.4)}
    36%{transform:translate3d(58vw,66vh,0) scale(.68)}54%{transform:translate3d(28vw,76vh,0) scale(1.3)}
    72%{transform:translate3d(20vw,44vh,0) scale(.86)}88%{transform:translate3d(32vw,22vh,0) scale(1.18)}
    100%{transform:translate3d(48vw,42vh,0) scale(1)}}
  @keyframes drift4{
    0%{transform:translate3d(78vw,80vh,0) scale(1.05)}16%{transform:translate3d(46vw,90vh,0) scale(1.4)}
    33%{transform:translate3d(20vw,72vh,0) scale(.75)}49%{transform:translate3d(34vw,48vh,0) scale(1.32)}
    65%{transform:translate3d(66vw,40vh,0) scale(.8)}82%{transform:translate3d(88vw,58vh,0) scale(1.18)}
    100%{transform:translate3d(78vw,80vh,0) scale(1.05)}}
  @keyframes drift5{
    0%{transform:translate3d(18vw,82vh,0) scale(1.1)}20%{transform:translate3d(40vw,66vh,0) scale(.72)}
    40%{transform:translate3d(34vw,36vh,0) scale(1.35)}60%{transform:translate3d(12vw,48vh,0) scale(.82)}
    80%{transform:translate3d(4vw,70vh,0) scale(1.24)}100%{transform:translate3d(18vw,82vh,0) scale(1.1)}}
  @keyframes drift6{
    0%{transform:translate3d(42vw,10vh,0) scale(.9)}22%{transform:translate3d(72vw,20vh,0) scale(1.45)}
    46%{transform:translate3d(78vw,42vh,0) scale(.85)}68%{transform:translate3d(50vw,30vh,0) scale(1.28)}
    86%{transform:translate3d(24vw,22vh,0) scale(.8)}100%{transform:translate3d(42vw,10vh,0) scale(.9)}}
  @keyframes drift7{
    0%{transform:translate3d(54vw,92vh,0) scale(1.05)}18%{transform:translate3d(76vw,74vh,0) scale(.7)}
    36%{transform:translate3d(62vw,52vh,0) scale(1.4)}54%{transform:translate3d(38vw,60vh,0) scale(.82)}
    72%{transform:translate3d(28vw,82vh,0) scale(1.32)}88%{transform:translate3d(40vw,96vh,0) scale(.9)}
    100%{transform:translate3d(54vw,92vh,0) scale(1.05)}}
  @keyframes drift8{
    0%{transform:translate3d(64vw,30vh,0) scale(1)}20%{transform:translate3d(84vw,56vh,0) scale(1.36)}
    40%{transform:translate3d(64vw,80vh,0) scale(.68)}60%{transform:translate3d(36vw,76vh,0) scale(1.3)}
    80%{transform:translate3d(26vw,50vh,0) scale(.85)}100%{transform:translate3d(64vw,30vh,0) scale(1)}}

  @media (prefers-reduced-motion: reduce){ .blob{ animation:none !important; } }
`
