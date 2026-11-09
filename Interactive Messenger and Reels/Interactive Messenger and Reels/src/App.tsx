import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

type View = "chats" | "reels" | "contacts" | "calls"
type Message = {
  id: string
  sender: "me" | "them" | "ai"
  text?: string
  time: string
  status?: "sent" | "delivered" | "read"
  media?: { type: "image" | "video" url: string name: string }
  reelId?: string
}
type Chat = { id: string userId: string messages: Message[] }
type Comment = {
  id: string
  author: string
  authorId?: string
  text: string
  time?: string
  likes?: number
  liked?: boolean
  replyTo?: string
}
type PersistedState = {
  chats: Chat[]
  contactIds: string[]
  liked: string[]
  saved: string[]
  comments: Record<string, Comment[]>
}

const A = "/assets/"
const users = [
  {
    id: "trump",
    name: "Трамп",
    handle: "@tramp",
    avatar: `${A}36ce6.png`,
    status: "был недавно",
  },
  {
    id: "artem",
    name: "Артём",
    handle: "@artem.coffee",
    avatar: `${A}4b2bf.png`,
    status: "в сети",
  },
  {
    id: "daniyar",
    name: "Данияр",
    handle: "@daniyar",
    avatar: `${A}e3b58.png`,
    status: "в сети",
  },
  {
    id: "alina",
    name: "Алина",
    handle: "@alina",
    avatar: `${A}50ddc.png`,
    status: "была недавно",
  },
  {
    id: "nikita",
    name: "Никита",
    handle: "@nikita.frames",
    avatar: `${A}35f66.png`,
    status: "в сети",
  },
  {
    id: "alex",
    name: "Алексей",
    handle: "@alexey",
    avatar: `${A}4f2c0.png`,
    status: "был недавно",
  },
  {
    id: "marina",
    name: "Марина",
    handle: "@marina.travels",
    avatar: `${A}54055.png`,
    status: "в сети",
  },
  {
    id: "sergey",
    name: "Сергей",
    handle: "@sergey",
    avatar: `${A}20f38.png`,
    status: "был недавно",
  },
  {
    id: "viktoria",
    name: "Виктория",
    handle: "@viktoria.design",
    avatar: `${A}40856.png`,
    status: "в сети",
  },
  {
    id: "maksim",
    name: "Максим",
    handle: "@max.motion",
    avatar: `${A}392f5.png`,
    status: "был недавно",
  },
]

const reels = [
  {
    id: "mountains",
    poster: `${A}c6d30.png`,
    authorId: "marina",
    location: "Алматы, Казахстан",
    duration: "0:24",
    caption: "Лучший способ перезагрузиться — уйти туда, где нет уведомлений",
    tags: "#алматы  #горы  #маленькоепутешествие",
    music: "Ólafur Arnalds — Near Light",
    likes: 12400,
  },
  {
    id: "coffee",
    poster: `${A}4d003.png`,
    authorId: "artem",
    location: "Где-то рядом",
    duration: "0:18",
    caption: "Маленький утренний ритуал. А вы с чего начинаете свой день?",
    tags: "#кофе  #утро  #моменты",
    music: "good morning — atom coffee",
    likes: 8600,
  },
  {
    id: "city",
    poster: `${A}e0c08.png`,
    authorId: "nikita",
    location: "После дождя",
    duration: "0:32",
    caption: "Когда город замирает свет, начинаются совсем другие истории.",
    tags: "#город  #вечер  #вкадре",
    music: "Tycho — A Walk",
    likes: 6205,
  },
]

const seedChats: Chat[] = [
  {
    id: "chat-trump",
    userId: "trump",
    messages: [
      {
        id: "t1",
        sender: "them",
        text: "Привет! Созвонимся после обеда?",
        time: "08:02",
      },
      {
        id: "t2",
        sender: "me",
        text: "Да, давай в 15:00",
        time: "08:07",
        status: "read",
      },
    ],
  },
  {
    id: "chat-artem",
    userId: "artem",
    messages: [
      {
        id: "a1",
        sender: "them",
        text: "Я собрал материалы по проекту",
        time: "18:32",
      },
      {
        id: "a2",
        sender: "me",
        text: "Отлично, жду!",
        time: "18:41",
        status: "read",
      },
      { id: "a3", sender: "them", text: "Скину всё вечером", time: "18:44" },
    ],
  },
  {
    id: "chat-daniyar",
    userId: "daniyar",
    messages: [
      {
        id: "d1",
        sender: "them",
        text: "Завтра встречаемся у входа",
        time: "12:20",
      },
      {
        id: "d2",
        sender: "me",
        text: "Хорошо, буду вовремя",
        time: "12:24",
        status: "delivered",
      },
    ],
  },
  {
    id: "chat-alina",
    userId: "alina",
    messages: [
      {
        id: "l1",
        sender: "them",
        text: "Встретимся в четверг?",
        time: "20:14",
      },
    ],
  },
  {
    id: "chat-nikita",
    userId: "nikita",
    messages: [
      {
        id: "n1",
        sender: "them",
        text: "Сохранил адрес на завтра",
        time: "19:03",
      },
    ],
  },
]

const initialState: PersistedState = {
  chats: seedChats,
  contactIds: users.slice(0, 8).map((user) => user.id),
  liked: [],
  saved: [],
  comments: {
    mountains: [
      {
        id: "c1",
        author: "Алина",
        authorId: "alina",
        text: "Какой потрясающий вид!",
        time: "12 мин.",
        likes: 18,
      },
      {
        id: "c2",
        author: "Данияр",
        authorId: "daniyar",
        text: "Тоже хочу туда.",
        time: "8 мин.",
        likes: 4,
      },
    ],
    coffee: [
      {
        id: "c3",
        author: "Марина",
        authorId: "marina",
        text: "Идеальное утро.",
        time: "24 мин.",
        likes: 7,
      },
    ],
  },
}

function now() {
  return new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function Icon({ name, size = 22 }: { name: string size?: number }) {
  const paths: Record<string, JSX.Element> = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    chats: (
      <path d="M5 17l-1 4 4-2h9a4 4 0 004-4V8a4 4 0 00-4-4H7a4 4 0 00-4 4v5a4 4 0 002 4z" />
    ),
    contacts: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0116 0" />
      </>
    ),
    calls: <path d="M7 3l3 5-2 2a15 15 0 006 6l2-2 5 3-2 4C10 21 3 14 3 5z" />,
    back: <path d="M15 18l-6-6 6-6" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-4-4" />
      </>
    ),
    send: <path d="M3 11l18-8-8 18-2-8-8-2zm8 2l4-4" />,
    attach: <path d="M8 12l5-5a4 4 0 015 5l-7 7a6 6 0 01-8-8l7-7" />,
    ai: (
      <>
        <path d="M12 3l1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8L12 3z" />
        <path d="M18 15l.7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15z" />
      </>
    ),
    close: <path d="M6 6l12 12M18 6L6 18" />,
    play: <path d="M8 5l11 7-11 7z" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    volume: (
      <>
        <path d="M4 10v4h4l5 4V6L8 10z" />
        <path d="M17 9a4 4 0 010 6" />
      </>
    ),
    mute: (
      <>
        <path d="M4 10v4h4l5 4V6L8 10z" />
        <path d="M17 10l4 4m0-4l-4 4" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M5 21a7 7 0 0114 0" />
      </>
    ),
    userPlus: (
      <>
        <circle cx="9" cy="8" r="4" />
        <path d="M2.5 21a6.5 6.5 0 0113 0M19 8v6M16 11h6" />
      </>
    ),
    heart: (
      <path d="M20.8 5.7a5.5 5.5 0 00-7.8 0L12 6.8l-1.1-1.1a5.5 5.5 0 00-7.8 7.8L12 22l8.8-8.5a5.5 5.5 0 000-7.8z" />
    ),
    reply: <path d="M9 8l-5 4 5 4v-3h4c3.5 0 5.5 1.5 7 4-1-5.5-4-8-7-8H9z" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
        <circle cx="19" cy="12" r="1" fill="currentColor" />
      </>
    ),
  }
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

function App() {
  const [data, setData] = useState<PersistedState>(() => {
    try {
      const saved = localStorage.getItem("messenger-state-v1")
      if (!saved) return initialState
      const parsed = JSON.parse(saved) as Partial<PersistedState>
      return {
        ...initialState,
        ...parsed,
        contactIds: parsed.contactIds || initialState.contactIds,
      }
    } catch {
      return initialState
    }
  })
  const [view, setView] = useState<View>("chats")
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [aiDraft, setAiDraft] = useState(false)
  const [search, setSearch] = useState("")
  const [profileId, setProfileId] = useState<string | null>(null)
  const [activeReel, setActiveReel] = useState(0)
  const [commentsFor, setCommentsFor] = useState<string | null>(null)
  const [shareFor, setShareFor] = useState<string | null>(null)
  const [addContactOpen, setAddContactOpen] = useState(false)
  const [toast, setToast] = useState("")

  useEffect(
    () => localStorage.setItem("messenger-state-v1", JSON.stringify(data)),
    [data],
  )
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(""), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const activeChat = data.chats.find((chat) => chat.id === activeChatId)
  const activeUser =
    activeChat?.userId === "ai"
      ? null
      : users.find((user) => user.id === activeChat?.userId)

  function openUser(userId: string) {
    let chat = data.chats.find((item) => item.userId === userId)
    if (!chat) {
      chat = { id: `chat-${userId}`, userId, messages: [] }
      setData((current) => ({ ...current, chats: [...current.chats, chat!] }))
    }
    setAiDraft(false)
    setActiveChatId(chat.id)
    setView("chats")
  }

  function openAI() {
    const chat = data.chats.find((item) => item.userId === "ai")
    if (chat) setActiveChatId(chat.id)
    else {
      setActiveChatId(null)
      setAiDraft(true)
    }
    setView("chats")
  }

  function sendMessage(
    message: Omit<Message, "id" | "time" | "sender">,
    isAI = false,
  ) {
    const sent: Message = {
      ...message,
      id: crypto.randomUUID(),
      time: now(),
      sender: "me",
      status: "sent",
    }
    if (isAI && !activeChat) {
      const newChat: Chat = { id: "chat-ai", userId: "ai", messages: [sent] }
      setData((current) => ({ ...current, chats: [newChat, ...current.chats] }))
      setActiveChatId("chat-ai")
      setAiDraft(false)
      window.setTimeout(() => replyFromAI(sent.text || "", "chat-ai"), 700)
      return
    }
    if (!activeChatId) return
    setData((current) => ({
      ...current,
      chats: [
        {
          ...current.chats.find((chat) => chat.id === activeChatId)!,
          messages: [
            ...(current.chats.find((chat) => chat.id === activeChatId)
              ?.messages || []),
            sent,
          ],
        },
        ...current.chats.filter((chat) => chat.id !== activeChatId),
      ],
    }))
    window.setTimeout(() => {
      setData((current) => ({
        ...current,
        chats: current.chats.map((chat) =>
          chat.id === activeChatId
            ? {
                ...chat,
                messages: chat.messages.map((item) =>
                  item.id === sent.id ? { ...item, status: "read" } : item,
                ),
              }
            : chat,
        ),
      }))
    }, 900)
    if (activeChat?.userId === "ai")
      window.setTimeout(() => replyFromAI(sent.text || "", activeChatId), 700)
  }

  function replyFromAI(prompt: string, chatId: string) {
    const history =
      data.chats
        .find((chat) => chat.id === chatId)
        ?.messages.map((item) => item.text)
        .filter(Boolean) || []
    const words = prompt.toLowerCase()
    let text = `Я учёл контекст нашей беседы${
      history.length ? ` (${history.length} сообщений)` : ""
    }. `
    if (words.includes("план"))
      text +=
        "Предлагаю начать с цели, разбить её на три коротких этапа и определить первый шаг на сегодня."
    else if (words.includes("reels") || words.includes("рил"))
      text +=
        "Для Reels лучше всего работает короткий хук, один ясный сюжет и финальный призыв к действию."
    else if (words.includes("привет"))
      text += "Привет! Чем помочь прямо сейчас?"
    else
      text += `По вашему запросу «${prompt.slice(0, 70)}» я бы сначала уточнил желаемый результат, а затем предложил конкретные шаги.`
    const reply: Message = {
      id: crypto.randomUUID(),
      sender: "ai",
      text,
      time: now(),
    }
    setData((current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.id === chatId
          ? { ...chat, messages: [...chat.messages, reply] }
          : chat,
      ),
    }))
  }

  function openReel(reelId: string) {
    const index = reels.findIndex((reel) => reel.id === reelId)
    setActiveReel(Math.max(0, index))
    setView("reels")
  }

  return (
    <main className="app-shell">
      <Navigation view={view} onChange={setView} />
      {view === "chats" && (
        <>
          <ChatList
            chats={data.chats}
            activeId={activeChatId}
            search={search}
            setSearch={setSearch}
            onOpen={(id) => {
              setActiveChatId(id)
              setAiDraft(false)
            }}
            onAI={openAI}
            onAddContact={() => setAddContactOpen(true)}
          />
          <section
            className={`workspace ${
              activeChatId || aiDraft ? "mobile-open" : ""
            }`}
          >
            {activeChat || aiDraft ? (
              <Conversation
                chat={activeChat}
                user={activeUser}
                isAI={aiDraft || activeChat?.userId === "ai"}
                onBack={() => {
                  setActiveChatId(null)
                  setAiDraft(false)
                }}
                onProfile={() => activeUser && setProfileId(activeUser.id)}
                onSend={(message) => sendMessage(message, aiDraft)}
                onOpenReel={openReel}
              />
            ) : (
              <EmptyChats onAI={openAI} />
            )}
          </section>
        </>
      )}
      {view === "contacts" && (
        <Contacts
          search={search}
          setSearch={setSearch}
          onOpen={openUser}
          onProfile={setProfileId}
          contactIds={data.contactIds}
        />
      )}
      {view === "calls" && <Calls onOpen={openUser} />}
      {view === "reels" && (
        <Reels
          data={data}
          setData={setData}
          active={activeReel}
          setActive={setActiveReel}
          onComments={setCommentsFor}
          onShare={setShareFor}
          onProfile={setProfileId}
        />
      )}
      {profileId && (
        <Profile
          user={users.find((user) => user.id === profileId)!}
          onClose={() => setProfileId(null)}
          onMessage={openUser}
        />
      )}
      {commentsFor && (
        <Comments
          reelId={commentsFor}
          data={data}
          setData={setData}
          onClose={() => setCommentsFor(null)}
        />
      )}
      {shareFor && (
        <Share
          reelId={shareFor}
          data={data}
          setData={setData}
          onClose={() => setShareFor(null)}
          onDone={(count) => {
            setShareFor(null)
            setToast(`Reels отправлен: ${count}`)
          }}
        />
      )}
      {addContactOpen && (
        <AddContact
          contactIds={data.contactIds}
          onClose={() => setAddContactOpen(false)}
          onAdd={(userId) =>
            setData((current) => ({
              ...current,
              contactIds: current.contactIds.includes(userId)
                ? current.contactIds
                : [...current.contactIds, userId],
            }))
          }
          onMessage={(userId) => {
            openUser(userId)
            setAddContactOpen(false)
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  )
}

function Navigation({
  view,
  onChange,
}: {
  view: View
  onChange: (view: View) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const items: { id: View icon: string activeIcon: string label: string }[] = [
    { id: "chats", icon: "0fcde.svg", activeIcon: "edc05.svg", label: "Chats" },
    { id: "reels", icon: "0d4f7.svg", activeIcon: "139dd.svg", label: "Reels" },
    {
      id: "contacts",
      icon: "52222.svg",
      activeIcon: "565e3.svg",
      label: "Contacts",
    },
    { id: "calls", icon: "4d566.svg", activeIcon: "8360c.svg", label: "Calls" },
  ]
  return (
    <nav className="main-nav">
      <button
        className="nav-menu"
        aria-label="Меню"
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <Icon name="menu" size={18} />
      </button>
      {menuOpen && (
        <div className="nav-popover">
          <strong>Messenger</strong>
          <span>Все данные хранятся на этом устройстве</span>
          <button onClick={() => setMenuOpen(false)}>Закрыть</button>
        </div>
      )}
      <div className="nav-items">
        {items.map((item) => (
          <button
            key={item.id}
            className={view === item.id ? "active" : ""}
            onClick={() => onChange(item.id)}
          >
            <img
              className="nav-icon"
              src={`${A}${view === item.id ? item.activeIcon : item.icon}`}
              alt=""
            />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function ChatList({
  chats,
  activeId,
  search,
  setSearch,
  onOpen,
  onAI,
  onAddContact,
}: {
  chats: Chat[]
  activeId: string | null
  search: string
  setSearch: (value: string) => void
  onOpen: (id: string) => void
  onAI: () => void
  onAddContact: () => void
}) {
  const [filter, setFilter] = useState("All")
  const [readIds, setReadIds] = useState<string[]>([])
  const list = chats.filter((chat) => {
    const name =
      chat.userId === "ai"
        ? "AI Помощник"
        : users.find((user) => user.id === chat.userId)?.name || ""
    const matchesSearch =
      name.toLowerCase().includes(search.toLowerCase()) ||
      (chat.messages.at(-1)?.text || "")
        .toLowerCase()
        .includes(search.toLowerCase())
    const matchesFilter =
      filter === "All" ||
      (filter === "Student CLL" &&
        ["artem", "alina", "nikita"].includes(chat.userId)) ||
      (filter === "Колледж" &&
        ["daniyar", "alex", "sergey"].includes(chat.userId))
    return matchesSearch && matchesFilter
  })
  return (
    <aside
      className={`side-panel chats-panel ${activeId ? "mobile-hidden" : ""}`}
    >
      <div className="search-row">
        <label className="search">
          <Icon name="search" size={19} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
          />
        </label>
      </div>
      <div className="notice">
        <strong>Never miss a message!</strong>
        <span>Enable notifications to stay updated.</span>
      </div>
      <div className="filters">
        <button
          className={filter === "All" ? "selected" : ""}
          onClick={() => setFilter("All")}
        >
          All <b>{list.length}</b>
        </button>
        <button
          className={filter === "Student CLL" ? "selected" : ""}
          onClick={() => setFilter("Student CLL")}
        >
          Student CLL
        </button>
        <button
          className={filter === "Колледж" ? "selected" : ""}
          onClick={() => setFilter("Колледж")}
        >
          Колледж
        </button>
      </div>
      <div className="chat-list">
        {list.length === 0 && (
          <div className="empty-small">Диалоги не найдены</div>
        )}
        {list.map((chat) => {
          const isAI = chat.userId === "ai"
          const user = users.find((item) => item.id === chat.userId)
          const last = chat.messages.at(-1)
          const unread = last?.sender === "them" && !readIds.includes(chat.id)
          return (
            <button
              key={chat.id}
              className={`chat-row ${activeId === chat.id ? "selected" : ""}`}
              onClick={() => {
                setReadIds((current) =>
                  current.includes(chat.id) ? current : [...current, chat.id],
                )
                onOpen(chat.id)
              }}
            >
              {isAI ? (
                <span className="avatar ai-avatar">
                  <Icon name="ai" />
                </span>
              ) : (
                <img className="avatar" src={user?.avatar} alt="" />
              )}
              <span className="chat-copy">
                <span className="chat-top">
                  <strong>{isAI ? "AI Помощник" : user?.name}</strong>
                  <time>{last?.time}</time>
                </span>
                <span className="chat-preview">
                  {last?.sender === "me" && <i>✓✓</i>}
                  {last?.reelId
                    ? "Reels"
                    : last?.media
                      ? last.media.name
                      : last?.text}
                  {unread && <b className="unread-badge">1</b>}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="chat-fabs">
        <button
          className="contact-fab"
          onClick={onAddContact}
          title="Добавить контакт"
          aria-label="Добавить контакт"
        >
          <Icon name="userPlus" size={23} />
        </button>
        <button
          className="ai-button"
          onClick={onAI}
          title="Новый чат с ИИ"
          aria-label="Открыть чат с ИИ"
        >
          <Icon name="ai" size={24} />
          <span>AI</span>
        </button>
      </div>
    </aside>
  )
}

function EmptyChats({ onAI }: { onAI: () => void }) {
  return (
    <div className="empty-state">
      <span className="empty-ai">
        <Icon name="ai" size={30} />
      </span>
      <h1>Выберите диалог</h1>
      <p>Откройте чат слева или начните новый разговор с ИИ.</p>
      <button className="primary" onClick={onAI}>
        Спросить ИИ
      </button>
    </div>
  )
}

function Conversation({
  chat,
  user,
  isAI,
  onBack,
  onProfile,
  onSend,
  onOpenReel,
}: {
  chat?: Chat
  user?: typeof users[number]
  isAI: boolean
  onBack: () => void
  onProfile: () => void
  onSend: (message: Omit<Message, "id" | "time" | "sender">) => void
  onOpenReel: (id: string) => void
}) {
  const [text, setText] = useState("")
  const [messageSearch, setMessageSearch] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(
    () => endRef.current?.scrollIntoView({ behavior: "smooth" }),
    [chat?.messages.length],
  )
  function submit() {
    if (!text.trim()) return
    onSend({ text: text.trim() })
    setText("")
  }
  function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 3_000_000) return
    const reader = new FileReader()
    reader.onload = () =>
      onSend({
        media: {
          type: file.type.startsWith("video") ? "video" : "image",
          url: String(reader.result),
          name: file.name,
        },
      })
    reader.readAsDataURL(file)
    event.target.value = ""
  }
  return (
    <div className="conversation">
      <header className="conversation-head">
        <button className="back" onClick={onBack}>
          <Icon name="back" />
        </button>
        <button className="person" onClick={onProfile} disabled={isAI}>
          {isAI ? (
            <span className="avatar ai-avatar">
              <Icon name="ai" />
            </span>
          ) : (
            <img className="avatar" src={user?.avatar} alt="" />
          )}
          <span>
            <strong>{isAI ? "AI Помощник" : user?.name}</strong>
            <small>
              {isAI ? "локальный контекстный помощник" : user?.status}
            </small>
          </span>
        </button>
        {!isAI && (
          <div className="conversation-actions">
            <button
              className="head-action"
              onClick={() => {
                setSearchOpen(!searchOpen)
                setMenuOpen(false)
              }}
              aria-label="Поиск в чате"
            >
              <Icon name="search" size={20} />
            </button>
            <button
              className="head-action"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Действия с чатом"
            >
              <Icon name="more" size={20} />
            </button>
            {menuOpen && (
              <div className="chat-menu">
                <button
                  onClick={() => {
                    onProfile()
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="user" size={18} />
                  Открыть профиль
                </button>
                <button
                  onClick={() => {
                    setSearchOpen(true)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="search" size={18} />
                  Поиск сообщений
                </button>
              </div>
            )}
          </div>
        )}
      </header>
      {searchOpen && (
        <div className="in-chat-search">
          <Icon name="search" size={18} />
          <input
            autoFocus
            value={messageSearch}
            onChange={(event) => setMessageSearch(event.target.value)}
            placeholder="Поиск в переписке"
          />
          {messageSearch && (
            <span>
              {
                chat?.messages.filter((message) =>
                  message.text
                    ?.toLowerCase()
                    .includes(messageSearch.toLowerCase()),
                ).length
              }
            </span>
          )}
          <button
            onClick={() => {
              setSearchOpen(false)
              setMessageSearch("")
            }}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      <div className="messages">
        {(!chat || chat.messages.length === 0) && (
          <div className="day-note">
            {isAI
              ? "Напишите первое сообщение — после этого чат сохранится в списке."
              : "Начните переписку"}
          </div>
        )}
        {chat?.messages
          .filter(
            (message) =>
              !messageSearch ||
              message.text?.toLowerCase().includes(messageSearch.toLowerCase()),
          )
          .map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onOpenReel={onOpenReel}
            />
          ))}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <label className="attach" title="Добавить изображение или видео">
          <Icon name="attach" />
          <input type="file" accept="image/*,video/*" onChange={attach} />
        </label>
        <textarea
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={isAI ? "Спросите что-нибудь…" : "Напишите сообщение…"}
        />
        <button className="send" onClick={submit} disabled={!text.trim()}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  onOpenReel,
}: {
  message: Message
  onOpenReel: (id: string) => void
}) {
  const reel = reels.find((item) => item.id === message.reelId)
  const author = users.find((item) => item.id === reel?.authorId)
  return (
    <div className={`message-line ${message.sender}`}>
      <div className="bubble">
        {reel && (
          <button className="reel-card" onClick={() => onOpenReel(reel.id)}>
            <span className="reel-preview">
              <img src={reel.poster} alt="" />
              <i>
                <Icon name="play" />
              </i>
            </span>
            <span>
              <strong>Reels · {author?.name}</strong>
              <small>Открыть оригинал</small>
            </span>
          </button>
        )}
        {message.media?.type === "image" && (
          <img
            className="sent-media"
            src={message.media.url}
            alt={message.media.name}
          />
        )}
        {message.media?.type === "video" && (
          <video className="sent-media" controls src={message.media.url} />
        )}
        {message.text && <p>{message.text}</p>}
        <span className="meta">
          {message.time}
          {message.sender === "me" && (
            <i>{message.status === "sent" ? "✓" : "✓✓"}</i>
          )}
        </span>
      </div>
    </div>
  )
}

function Contacts({
  search,
  setSearch,
  onOpen,
  onProfile,
  contactIds,
}: {
  search: string
  setSearch: (value: string) => void
  onOpen: (id: string) => void
  onProfile: (id: string) => void
  contactIds: string[]
}) {
  const list = users.filter(
    (user) =>
      contactIds.includes(user.id) &&
      user.name.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <section className="section-view contacts-view">
      <div className="section-panel">
        <label className="search outlined">
          <Icon name="search" size={19} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
          />
        </label>
        <h1>Контакты</h1>
        {list.map((user) => (
          <div className="contact-row" key={user.id}>
            <button onClick={() => onProfile(user.id)}>
              <img className="avatar" src={user.avatar} alt="" />
              <span>
                <strong>{user.name}</strong>
                <small>{user.status}</small>
              </span>
            </button>
            <button className="message-mini" onClick={() => onOpen(user.id)}>
              <Icon name="chats" size={19} />
            </button>
          </div>
        ))}
      </div>
      <div className="pattern-space" />
    </section>
  )
}

function Calls({ onOpen }: { onOpen: (id: string) => void }) {
  const [calling, setCalling] = useState<string | null>(null)
  return (
    <section className="section-view calls-view">
      <div className="section-panel">
        <h1>Calls</h1>
        <button className="new-call" onClick={() => setCalling("Новый звонок")}>
          <span>
            <Icon name="calls" />
          </span>
          <strong>Start New Call</strong>
        </button>
        <p className="muted">You can add up to 200 participants to a call.</p>
        {users.slice(0, 7).map((user, index) => (
          <button
            className="call-row"
            key={`${user.id}-${index}`}
            onClick={() => setCalling(user.name)}
          >
            <img className="avatar" src={user.avatar} alt="" />
            <span>
              <strong>{user.name}</strong>
              <small>
                {index < 2
                  ? "Yesterday"
                  : `Oct ${28 - index} at ${13 + index}:34`}
              </small>
            </span>
          </button>
        ))}
      </div>
      <div className="pattern-space" />
      {calling && (
        <div className="call-overlay">
          <span className="call-pulse">
            <Icon name="calls" size={30} />
          </span>
          <strong>{calling}</strong>
          <small>Устанавливаем соединение…</small>
          <div>
            {calling !== "Новый звонок" && (
              <button
                onClick={() => {
                  const user = users.find((item) => item.name === calling)
                  if (user) onOpen(user.id)
                }}
              >
                Перейти в чат
              </button>
            )}
            <button onClick={() => setCalling(null)}>Завершить</button>
          </div>
        </div>
      )}
    </section>
  )
}

function Reels({
  data,
  setData,
  active,
  setActive,
  onComments,
  onShare,
  onProfile,
}: {
  data: PersistedState
  setData: React.Dispatch<React.SetStateAction<PersistedState>>
  active: number
  setActive: (value: number) => void
  onComments: (id: string) => void
  onShare: (id: string) => void
  onProfile: (id: string) => void
}) {
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [feed, setFeed] = useState<"for-you" | "following">("for-you")
  const [query, setQuery] = useState("")
  const [following, setFollowing] = useState<string[]>([])
  const reel = reels[active]
  const author = users.find((user) => user.id === reel.authorId)!
  const liked = data.liked.includes(reel.id)
  const saved = data.saved.includes(reel.id)
  function toggle(key: "liked" | "saved") {
    setData((current) => ({
      ...current,
      [key]: current[key].includes(reel.id)
        ? current[key].filter((id) => id !== reel.id)
        : [...current[key], reel.id],
    }))
  }
  return (
    <section className="reels-view">
      <header className="reels-head">
        <div>
          <img src={`${A}139dd.svg`} alt="" />
          <h1>Reels</h1>
        </div>
        <nav>
          <button
            className={feed === "for-you" ? "active" : ""}
            onClick={() => setFeed("for-you")}
          >
            Для вас
          </button>
          <button
            className={feed === "following" ? "active" : ""}
            onClick={() => setFeed("following")}
          >
            Подписки
          </button>
        </nav>
        <label
          className="reels-search"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            const found = reels.findIndex((item) =>
              users
                .find((user) => user.id === item.authorId)
                ?.name.toLowerCase()
                .includes(query.toLowerCase()),
            )
            if (found >= 0) setActive(found)
          }}
        >
          <Icon name="search" size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск в Reels"
          />
        </label>
      </header>
      <div
        className="reels-stage"
        onWheel={(event) => {
          if (Math.abs(event.deltaY) < 10) return
          setActive(
            Math.min(
              reels.length - 1,
              Math.max(0, active + (event.deltaY > 0 ? 1 : -1)),
            ),
          )
        }}
      >
        <article
          className={`reel-poster ${paused ? "paused" : ""}`}
          onClick={() => setPaused(!paused)}
        >
          <img key={reel.id} src={reel.poster} alt="" />
          <div className="poster-shade" />
          <div className="reel-top">
            <span>{reel.location}</span>
            <time>{reel.duration}</time>
          </div>
          {paused && (
            <span className="paused-indicator">
              <Icon name="play" size={32} />
            </span>
          )}
          <div className="reel-caption">
            <div className="reel-author">
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onProfile(author.id)
                }}
              >
                <img src={author.avatar} alt="" />
                <span>
                  <strong>{author.name}</strong>
                  <small>{author.handle}</small>
                </span>
              </button>
              <button
                className={`follow ${
                  following.includes(author.id) ? "following" : ""
                }`}
                onClick={(event) => {
                  event.stopPropagation()
                  setFollowing((current) =>
                    current.includes(author.id)
                      ? current.filter((id) => id !== author.id)
                      : [...current, author.id],
                  )
                }}
              >
                {following.includes(author.id) ? "Вы подписаны" : "Подписаться"}
              </button>
            </div>
            <p>{reel.caption}</p>
            <p className="tags">{reel.tags}</p>
            <small>{reel.music}</small>
          </div>
        </article>
        <div className="reel-actions">
          <Action
            icon={`${A}a0a28.svg`}
            label={(reel.likes + (liked ? 1 : 0)).toLocaleString("ru-RU")}
            active={liked}
            onClick={() => toggle("liked")}
          />
          <Action
            icon={`${A}9d182.svg`}
            label={String(data.comments[reel.id]?.length || 0)}
            onClick={() => onComments(reel.id)}
          />
          <Action
            icon={`${A}56c43.svg`}
            label="Отправить"
            onClick={() => onShare(reel.id)}
          />
          <Action
            icon={`${A}e56d5.svg`}
            label="Сохранить"
            active={saved}
            onClick={() => toggle("saved")}
          />
          <button
            className="round-action sound"
            onClick={() => setMuted(!muted)}
          >
            <Icon name={muted ? "mute" : "volume"} />
            <span>{muted ? "Без звука" : "Звук"}</span>
          </button>
        </div>
        <div className="reel-arrows">
          <button disabled={active === 0} onClick={() => setActive(active - 1)}>
            <span>↑</span>
          </button>
          <button
            disabled={active === reels.length - 1}
            onClick={() => setActive(active + 1)}
          >
            <span>↓</span>
          </button>
        </div>
      </div>
    </section>
  )
}

function Action({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`round-action ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <i>
        <img src={icon} alt="" />
      </i>
      <span>{label}</span>
    </button>
  )
}

function Profile({
  user,
  onClose,
  onMessage,
}: {
  user: typeof users[number]
  onClose: () => void
  onMessage: (id: string) => void
}) {
  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <section
        className="profile-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose}>
          <Icon name="close" />
        </button>
        <img className="profile-avatar" src={user.avatar} alt="" />
        <h2>{user.name}</h2>
        <p>{user.handle}</p>
        <span className="online">{user.status}</span>
        <button
          className="primary wide"
          onClick={() => {
            onMessage(user.id)
            onClose()
          }}
        >
          Написать сообщение
        </button>
      </section>
    </div>
  )
}

function AddContact({
  contactIds,
  onClose,
  onAdd,
  onMessage,
}: {
  contactIds: string[]
  onClose: () => void
  onAdd: (userId: string) => void
  onMessage: (userId: string) => void
}) {
  const [query, setQuery] = useState("")
  const [added, setAdded] = useState<string[]>([])
  const found = users.filter((user) => {
    const needle = query.trim().toLowerCase()
    return (
      !contactIds.includes(user.id) &&
      !added.includes(user.id) &&
      (!needle ||
        user.name.toLowerCase().includes(needle) ||
        user.handle.toLowerCase().includes(needle))
    )
  })
  return (
    <div className="modal-layer contact-modal-layer" onMouseDown={onClose}>
      <section
        className="add-contact-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="modal-title-icon">
              <Icon name="userPlus" size={21} />
            </span>
            <div>
              <h2>Добавить контакт</h2>
              <p>Найдите пользователя по имени или никнейму</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Закрыть">
            <Icon name="close" />
          </button>
        </header>
        <label className="search contact-search">
          <Icon name="search" size={19} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Имя или @username"
          />
        </label>
        <div className="contact-results">
          {found.map((user) => (
            <div className="contact-result" key={user.id}>
              <img src={user.avatar} alt="" />
              <span>
                <strong>{user.name}</strong>
                <small>{user.handle}</small>
              </span>
              <button
                onClick={() => {
                  onAdd(user.id)
                  setAdded((current) => [...current, user.id])
                }}
              >
                Добавить
              </button>
            </div>
          ))}
          {!found.length && added.length === 0 && (
            <div className="empty-small">
              {query
                ? "Пользователь не найден"
                : "Все пользователи уже добавлены"}
            </div>
          )}
          {added.map((id) => {
            const user = users.find((item) => item.id === id)!
            return (
              <div className="contact-result added" key={id}>
                <img src={user.avatar} alt="" />
                <span>
                  <strong>{user.name}</strong>
                  <small>Контакт добавлен</small>
                </span>
                <button onClick={() => onMessage(id)}>Написать</button>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function Comments({
  reelId,
  data,
  setData,
  onClose,
}: {
  reelId: string
  data: PersistedState
  setData: React.Dispatch<React.SetStateAction<PersistedState>>
  onClose: () => void
}) {
  const [text, setText] = useState("")
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const comments = data.comments[reelId] || []
  function add(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) return
    setData((current) => ({
      ...current,
      comments: {
        ...current.comments,
        [reelId]: [
          ...(current.comments[reelId] || []),
          {
            id: crypto.randomUUID(),
            author: "Вы",
            authorId: "me",
            text: text.trim(),
            time: "только что",
            likes: 0,
            replyTo: replyTo || undefined,
          },
        ],
      },
    }))
    setText("")
    setReplyTo(null)
  }
  function toggleLike(commentId: string) {
    setData((current) => ({
      ...current,
      comments: {
        ...current.comments,
        [reelId]: (current.comments[reelId] || []).map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                liked: !comment.liked,
                likes: Math.max(
                  0,
                  (comment.likes || 0) + (comment.liked ? -1 : 1),
                ),
              }
            : comment,
        ),
      },
    }))
  }
  return (
    <div className="modal-layer right-layer" onMouseDown={onClose}>
      <section
        className="drawer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>Комментарии</h2>
            <span>{comments.length}</span>
          </div>
          <button onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="comment-list">
          {comments.map((comment) => {
            const person = users.find(
              (user) =>
                user.id === comment.authorId || user.name === comment.author,
            )
            return (
              <div className="comment" key={comment.id}>
                {person ? (
                  <img className="comment-avatar" src={person.avatar} alt="" />
                ) : (
                  <span className="comment-avatar mine">В</span>
                )}
                <div className="comment-body">
                  <p>
                    <strong>{comment.author}</strong>
                    {comment.replyTo && (
                      <span className="reply-label">@{comment.replyTo}</span>
                    )}
                    <span>{comment.text}</span>
                  </p>
                  <div className="comment-meta">
                    <time>{comment.time || "недавно"}</time>
                    <button
                      onClick={() => {
                        setReplyTo(comment.author)
                        inputRef.current?.focus()
                      }}
                    >
                      Ответить
                    </button>
                  </div>
                </div>
                <button
                  className={`comment-like ${comment.liked ? "active" : ""}`}
                  onClick={() => toggleLike(comment.id)}
                  aria-label="Нравится"
                >
                  <Icon name="heart" size={16} />
                  {!!comment.likes && <span>{comment.likes}</span>}
                </button>
              </div>
            )
          })}
          {!comments.length && (
            <div className="empty-small">Пока нет комментариев</div>
          )}
        </div>
        <div className="comment-composer">
          {replyTo && (
            <div className="replying">
              <span>
                Ответ для <strong>{replyTo}</strong>
              </span>
              <button onClick={() => setReplyTo(null)}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          <form className="drawer-form" onSubmit={add}>
            <span className="my-comment-avatar">В</span>
            <input
              ref={inputRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                replyTo ? `Ответить ${replyTo}…` : "Добавить комментарий…"
              }
            />
            <button disabled={!text.trim()} aria-label="Отправить">
              <Icon name="send" size={20} />
            </button>
          </form>
        </div>
      </section>
    </div>
  )
}

function Share({
  reelId,
  data,
  setData,
  onClose,
  onDone,
}: {
  reelId: string
  data: PersistedState
  setData: React.Dispatch<React.SetStateAction<PersistedState>>
  onClose: () => void
  onDone: (count: number) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState("")
  const [caption, setCaption] = useState("")
  const frequent = useMemo(
    () =>
      [...users]
        .sort((a, b) => {
          const aCount =
            data.chats.find((chat) => chat.userId === a.id)?.messages.length ||
            0
          const bCount =
            data.chats.find((chat) => chat.userId === b.id)?.messages.length ||
            0
          return bCount - aCount
        })
        .filter((user) =>
          user.name.toLowerCase().includes(search.toLowerCase()),
        ),
    [data.chats, search],
  )
  function send() {
    const stamp = now()
    setData((current) => {
      const chats = [...current.chats]
      selected.forEach((userId) => {
        const index = chats.findIndex((chat) => chat.userId === userId)
        const messages: Message[] = [
          {
            id: crypto.randomUUID(),
            sender: "me",
            reelId,
            text: caption.trim() || undefined,
            time: stamp,
            status: "sent",
          },
        ]
        if (index >= 0)
          chats[index] = {
            ...chats[index],
            messages: [...chats[index].messages, ...messages],
          }
        else chats.push({ id: `chat-${userId}`, userId, messages })
      })
      return { ...current, chats }
    })
    onDone(selected.length)
  }
  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <section
        className="share-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>Отправить Reels</h2>
          <button onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <label className="search">
          <Icon name="search" size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск пользователя"
          />
        </label>
        <p className="share-label">Частые контакты</p>
        <div className="recipient-grid">
          {frequent.map((user) => (
            <button
              key={user.id}
              className={selected.includes(user.id) ? "selected" : ""}
              onClick={() =>
                setSelected((current) =>
                  current.includes(user.id)
                    ? current.filter((id) => id !== user.id)
                    : [...current, user.id],
                )
              }
            >
              <span>
                <img src={user.avatar} alt="" />
                {selected.includes(user.id) && <i>✓</i>}
              </span>
              <strong>{user.name}</strong>
            </button>
          ))}
        </div>
        <input
          className="caption-input"
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Добавить сообщение…"
        />
        <button
          className="primary wide"
          disabled={!selected.length}
          onClick={send}
        >
          Отправить{selected.length ? ` · ${selected.length}` : ""}
        </button>
      </section>
    </div>
  )
}

export default App
