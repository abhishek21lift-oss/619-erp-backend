import Foundation

/// What the voice endpoints return: a number, and the sentence to say.
///
/// `spoken` comes from the server rather than being assembled here, so the
/// phrasing and its pluralisation can be corrected without an App Store
/// release. The client's job is to read it out, not to write it.
struct ClientCountResponse: Decodable {
    let count: Int
    let scope: String
    let spoken: String
}

/// One client, as the voice surface is willing to describe them.
///
/// Four facts and no contact details — the server does not select mobile,
/// email or address at all, so there is nothing here to leak by accident.
struct VoiceClient: Decodable, Identifiable {
    let id: String
    let clientId: String?
    let name: String
    let status: String?
    let packageType: String?
    let expiresOn: String?
    /// `nil` when the client has no end date on file: unknown, not lapsed.
    let expired: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case clientId = "client_id"
        case name
        case status
        case packageType = "package_type"
        case expiresOn = "expires_on"
        case expired
    }
}

struct ClientSearchResponse: Decodable {
    let query: String
    let count: Int
    let results: [VoiceClient]
    let spoken: String
}

/// Today's workout, as one of four states.
///
/// `none` and `unknown` are different answers and must stay different: one
/// says nothing was scheduled, the other says the log could not be read. A
/// voice surface that reports an unread log as "nothing scheduled" tells a
/// trainer their client has no session when they may well have one.
struct TodaySession: Decodable {
    let status: String
    let programName: String?

    enum CodingKeys: String, CodingKey {
        case status
        case programName = "program_name"
    }
}

/// One client in the detail a trainer actually asks for.
///
/// Still no contact details: the server does not select mobile, email or
/// address for this endpoint either. `sessionsRemaining` is optional because
/// "no balance on file" and "0 left" are different facts — collapsing the
/// first into the second would have Siri announce that a client has run out
/// when nothing was ever recorded.
struct ClientDetailResponse: Decodable {
    let id: String
    let name: String
    let status: String?
    let active: Bool
    let packageType: String?
    let expiresOn: String?
    /// `nil` when no end date is on file: unknown, not lapsed.
    let expired: Bool?
    /// `nil` when no balance is on file: unknown, not zero.
    let sessionsRemaining: Int?
    let today: TodaySession?
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case status
        case active
        case packageType = "package_type"
        case expiresOn = "expires_on"
        case expired
        case sessionsRemaining = "sessions_remaining"
        case today
        case spoken
    }
}

/// One entry on today's list.
///
/// `startTime` is `nil` whenever the studio never committed to a time —
/// a programme day, or a client whose preferred slot could not be parsed.
/// `timeSource` says where a present time came from, so a PREFERENCE is never
/// presented as an appointment.
struct TodayWorkout: Decodable, Identifiable {
    let id: String
    let clientName: String
    let programName: String?
    /// 'HH:MM', studio-local, or nil when there is no committed time.
    let startTime: String?
    /// "booked" | "preference" | nil
    let timeSource: String?
    let status: String
    let trainerName: String?
    /// "booked" | "programme" | "enrolment"
    let source: String

    enum CodingKeys: String, CodingKey {
        case id = "client_id"
        case clientName = "client_name"
        case programName = "program_name"
        case startTime = "start_time"
        case timeSource = "time_source"
        case status
        case trainerName = "trainer_name"
        case source
    }
}

/// Today's roster.
///
/// `date` and `timezone` are the STUDIO's, resolved server-side. The phone's
/// own zone is deliberately not consulted: a trainer checking the roster from
/// another country must see the day the studio is operating on, not the day
/// where they happen to be standing.
struct TodayWorkoutsResponse: Decodable {
    let date: String
    let timezone: String
    let count: Int
    let bookedCount: Int
    let sessions: [TodayWorkout]
    let truncated: Bool
    /// `false` when the signed-in account is not attached to a trainer profile
    /// — a real state with its own sentence, not an error and not an empty day.
    let trainerLinked: Bool
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case date
        case timezone
        case count
        case bookedCount = "booked_count"
        case sessions
        case truncated
        case trainerLinked = "trainer_linked"
        case spoken
    }
}

/// One exercise in a prepared draft.
struct DraftExercise: Decodable, Identifiable {
    let exerciseId: String
    let name: String
    let muscleGroup: String?
    let dayOfWeek: Int
    let sets: Int
    let reps: Int

    var id: String { "\(dayOfWeek)-\(exerciseId)" }

    enum CodingKeys: String, CodingKey {
        case exerciseId = "exercise_id"
        case name
        case muscleGroup = "muscle_group"
        case dayOfWeek = "day_of_week"
        case sets
        case reps
    }
}

/// An exercise the safety filter withheld, and why.
///
/// Surfaced rather than hidden: a trainer told "I left out three exercises"
/// can disagree and go and look; one told nothing cannot.
struct ExcludedExercise: Decodable {
    let exerciseId: String
    let name: String
    let contraindication: String

    enum CodingKeys: String, CodingKey {
        case exerciseId = "exercise_id"
        case name
        case contraindication
    }
}

struct DraftPreview: Decodable {
    let clientName: String
    let planName: String
    let days: Int
    let goal: String?
    let difficulty: String?
    let basedOnPlanName: String?
    /// "ai" when a model chose the exercises, "derived" when the library did.
    let source: String
    let exercises: [DraftExercise]

    enum CodingKeys: String, CodingKey {
        case clientName = "client_name"
        case planName = "plan_name"
        case days
        case goal
        case difficulty
        case basedOnPlanName = "based_on_plan_name"
        case source
        case exercises
    }
}

/// What `/workouts/prepare` returns.
///
/// `saved` is always false here — that is the entire point of the endpoint,
/// and it is decoded rather than assumed so the field cannot quietly change
/// meaning without this failing to make sense.
struct WorkoutDraftResponse: Decodable {
    let draftId: String
    let expiresAt: String
    let preview: DraftPreview
    let screeningWarnings: [String]
    let excluded: [ExcludedExercise]
    let saved: Bool
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case draftId = "draft_id"
        case expiresAt = "expires_at"
        case preview
        case screeningWarnings = "screening_warnings"
        case excluded
        case saved
        case spoken
    }
}

/// What `/workouts/confirm` returns once something has actually been written.
struct WorkoutSavedResponse: Decodable {
    let saved: Bool
    let workoutPlanId: String
    /// The plan's NAME as well as its id. An id identifies the plan to
    /// software; the name is what a Shortcut can show and a person can
    /// recognise, and returning only the id makes every caller fetch it back.
    let workoutPlanName: String
    let clientName: String?
    let exerciseCount: Int
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case saved
        case workoutPlanId = "workout_plan_id"
        case workoutPlanName = "workout_plan_name"
        case clientName = "client_name"
        case exerciseCount = "exercise_count"
        case spoken
    }
}

/// What `/workouts/complete` returns.
///
/// `alreadyCompleted` is the field that matters. The endpoint is idempotent,
/// so a second request succeeds without writing — and the caller has to be
/// able to tell "I marked it done" from "it was already done", because saying
/// "done" when nothing changed teaches a trainer the command works when it
/// may not have.
struct WorkoutCompletedResponse: Decodable {
    let completed: Bool
    let alreadyCompleted: Bool
    let sessionId: String
    let clientName: String?
    let date: String
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case completed
        case alreadyCompleted = "already_completed"
        case sessionId = "session_id"
        case clientName = "client_name"
        case date
        case spoken
    }
}

/// The latest payment, and only the latest.
///
/// Three fields, chosen for what a spoken answer needs. There is deliberately
/// no receipt number, method or note here — the server does not select them,
/// because a payment history read aloud is a client's finances narrated to
/// whoever happens to be standing there.
struct LastPayment: Decodable {
    let amount: Double
    let status: String
    let date: String
}

struct PackageInfo: Decodable {
    let type: String?
    let expiresOn: String?

    enum CodingKeys: String, CodingKey {
        case type
        case expiresOn = "expires_on"
    }
}

/// What `/payments/client/:id/status` returns.
///
/// `outstanding` is optional because a missing balance is not a settled
/// account. `Number(null)` being `0` is the trap this models around: reporting
/// an empty column as "nothing owed" is a claim about the client made from no
/// data at all.
struct PaymentStatusResponse: Decodable {
    let clientName: String
    let currency: String
    let outstanding: Double?
    let lastPayment: LastPayment?
    let package: PackageInfo
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case clientName = "client_name"
        case currency
        case outstanding
        case lastPayment = "last_payment"
        case package
        case spoken
    }
}

/// An identical amount already recorded for this client, very recently.
///
/// The draft claim stops the same DRAFT being confirmed twice. It does nothing
/// about a person saying "record three thousand from Rahul" twice, which makes
/// two legitimate drafts — so the server surfaces this in the QUESTION, at the
/// one moment where somebody can still say no.
struct RecentDuplicate: Decodable {
    let amount: Double
    let minutesAgo: Int

    enum CodingKeys: String, CodingKey {
        case amount
        case minutesAgo = "minutes_ago"
    }
}

/// What `/payments/prepare` returns. `recorded` is always false.
struct PaymentDraftResponse: Decodable {
    let draftId: String
    let expiresAt: String
    let clientName: String
    let amount: Double
    let currency: String
    let method: String
    let outstandingBefore: Double?
    let recentDuplicate: RecentDuplicate?
    let recorded: Bool
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case draftId = "draft_id"
        case expiresAt = "expires_at"
        case clientName = "client_name"
        case amount
        case currency
        case method
        case outstandingBefore = "outstanding_before"
        case recentDuplicate = "recent_duplicate"
        case recorded
        case spoken
    }
}

/// What `/payments/confirm` returns once money has actually been recorded.
struct PaymentRecordedResponse: Decodable {
    let recorded: Bool
    let paymentId: String
    let receiptNo: String
    let clientName: String
    let amount: Double
    let outstandingAfter: Double?
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case recorded
        case paymentId = "payment_id"
        case receiptNo = "receipt_no"
        case clientName = "client_name"
        case amount
        case outstandingAfter = "outstanding_after"
        case spoken
    }
}

/// Every way this can fail, phrased as something Siri can say.
///
/// The distinction that matters is `unauthorized` vs `network`: one is fixed
/// by opening the app and signing in, the other by trying again in a moment.
/// Collapsing them into "something went wrong" sends the user to the wrong
/// remedy, which on a voice surface they cannot see or work around.
enum VoiceAPIError: LocalizedError {
    case notConfigured
    case notSignedIn
    case unauthorized
    case invalidQuery
    case notFound
    /// The server refused, and wrote the sentence to say about it.
    ///
    /// Needed from Phase 5 on. A medically blocked client is a 403, and
    /// mapping 403 to "please sign in" would tell a trainer to re-authenticate
    /// when the real answer is that their client needs medical clearance. The
    /// server already phrases every refusal it makes; when it does, that
    /// sentence wins over anything inferred from a status code.
    case refused(spoken: String)
    case rateLimited
    case server(status: Int)
    case network(underlying: Error)
    case malformedResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "MY PT STUDIO is not set up on this device yet."
        case .notSignedIn, .unauthorized:
            return "Please sign in to MY PT STUDIO first."
        case .invalidQuery:
            // The server bounds `q` at 2–60 characters. Say what to do about
            // it rather than reporting a validation failure.
            return "Please say at least two letters of the name."
        case .refused(let spoken):
            return spoken
        case .notFound:
            // Also what the server returns for a client belonging to ANOTHER
            // studio, deliberately — so this sentence must not distinguish
            // "gone" from "not yours". Saying "you do not have access to that
            // client" would confirm the id exists somewhere, which is the
            // thing the 404 is there to avoid.
            return "I could not find that client."
        case .rateLimited:
            return "Too many requests just now. Please try again in a moment."
        case .server:
            return "MY PT STUDIO could not answer that right now."
        case .network:
            return "I could not reach MY PT STUDIO. Check your connection."
        case .malformedResponse:
            return "MY PT STUDIO sent back something unexpected."
        }
    }
}

/// Talks to the MY PT STUDIO voice API.
///
/// ## No secrets in here
///
/// There is no API key, no client secret and no base URL literal in this file.
/// The base URL comes from the app's Info.plist (build configuration) and the
/// bearer token comes from the Keychain, written by the host app when the user
/// signs in normally. An intent never sees credentials, only a token that the
/// user's own sign-in produced.
///
/// ## The intent never sends a query
///
/// It sends a path and a bearer token. It does not send an organization id —
/// the server derives that from the session — so there is nothing this client
/// could set, by accident or otherwise, that would widen what it can read.
struct VoiceAPIClient {

    /// Keychain account name the host app writes the session token under.
    static let tokenAccount = "com.myptstudio.session.token"

    private let baseURL: URL
    private let accessGroup: String?
    private let session: URLSession

    /// - Parameters:
    ///   - baseURL: the API origin, from `MPS_API_BASE_URL` in Info.plist.
    ///   - accessGroup: the shared keychain group; nil in unit tests.
    init(baseURL: URL, accessGroup: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.accessGroup = accessGroup
        self.session = session
    }

    /// Build from the app's own configuration, or nil when it is missing.
    static func fromBundle(_ bundle: Bundle = .main) -> VoiceAPIClient? {
        guard
            let raw = bundle.object(forInfoDictionaryKey: "MPS_API_BASE_URL") as? String,
            let url = URL(string: raw),
            // https only. A voice token must never be sent in the clear, and a
            // misconfigured http base URL is a silent downgrade rather than a
            // visible failure.
            url.scheme == "https"
        else { return nil }

        let group = bundle.object(forInfoDictionaryKey: "MPS_KEYCHAIN_ACCESS_GROUP") as? String
        return VoiceAPIClient(baseURL: url, accessGroup: group)
    }

    /// GET /api/voice/dashboard/client-count
    func clientCount() async throws -> ClientCountResponse {
        try await get("api/voice/dashboard/client-count")
    }

    /// GET /api/voice/clients/search?q=…
    ///
    /// The term is percent-encoded into the query string; it is the only thing
    /// this client ever sends besides the token. No organization id, no
    /// trainer id, no field list — every decision about what may be returned
    /// belongs to the server.
    func searchClients(matching term: String) async throws -> ClientSearchResponse {
        let trimmed = term.trimmingCharacters(in: .whitespacesAndNewlines)
        // Checked here as well as on the server so an obviously-empty phrase
        // is answered instantly instead of costing a round trip and a 400.
        guard trimmed.count >= 2 else { throw VoiceAPIError.invalidQuery }

        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/voice/clients/search"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "q", value: trimmed)]
        guard let url = components?.url else { throw VoiceAPIError.invalidQuery }

        return try await get(url)
    }

    /// GET /api/voice/clients/:clientId
    ///
    /// Takes the opaque id Phase 2's search already returned — the intent
    /// never constructs one, and the server checks that the id belongs to the
    /// caller's organization before it reads anything. An id from another
    /// studio comes back 404, not 403, so a caller cannot use this endpoint to
    /// learn which ids exist.
    func clientDetail(id: String) async throws -> ClientDetailResponse {
        // Matched to the server's own bound on the path parameter. Checked
        // here so a malformed id fails locally instead of being encoded into
        // a path and sent — there is no id worth a round trip that this
        // rejects.
        let allowed = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard
            !id.isEmpty, id.count <= 64,
            id.unicodeScalars.allSatisfy({ allowed.contains($0) })
        else { throw VoiceAPIError.notFound }

        return try await get("api/voice/clients/\(id)")
    }

    /// GET /api/voice/workouts/today
    ///
    /// Sends nothing but the path and the token — no date, no timezone, no
    /// filter. "Today" is resolved on the server in the studio's own zone, so
    /// a phone with a wrong clock, a traveller's device, or a handset still on
    /// yesterday's date cannot shift which day is reported.
    func todaysWorkouts() async throws -> TodayWorkoutsResponse {
        try await get("api/voice/workouts/today")
    }

    /// POST /api/voice/workouts/prepare
    ///
    /// Prepares a draft and SAVES NOTHING. The returned `draftId` is the only
    /// thing `confirmWorkout` needs, and the only thing it accepts.
    func prepareWorkout(clientId: String, days: Int?) async throws -> WorkoutDraftResponse {
        var body: [String: Any] = ["client_id": clientId]
        if let days { body["days"] = days }
        return try await post("api/voice/workouts/prepare", body: body)
    }

    /// POST /api/voice/workouts/confirm
    ///
    /// The only call on this client that writes. It sends ONE id and nothing
    /// else — no exercises, no plan name, no client id. There is deliberately
    /// no parameter here through which this device could introduce an exercise
    /// into somebody's programme: the plan that gets saved is the one the
    /// server generated, checked against the library and filtered for
    /// contraindications when it prepared the draft.
    func confirmWorkout(draftId: String) async throws -> WorkoutSavedResponse {
        try await post("api/voice/workouts/confirm", body: ["draft_id": draftId])
    }

    /// POST /api/voice/workouts/complete
    ///
    /// Marks an existing session done. It does NOT create one: a client with
    /// nothing logged has not trained, and the server answers 404 rather than
    /// writing a completion for a workout that never happened.
    ///
    /// No date is sent for the ordinary case. "Today" is resolved server-side
    /// in the studio's own zone, so a handset with a wrong clock — or one in
    /// another country — cannot complete the wrong day's session.
    func completeWorkout(clientId: String, date: String? = nil) async throws -> WorkoutCompletedResponse {
        var body: [String: Any] = ["client_id": clientId]
        if let date { body["date"] = date }
        return try await post("api/voice/workouts/complete", body: body)
    }

    /// GET /api/voice/payments/client/:clientId/status
    func paymentStatus(clientId: String) async throws -> PaymentStatusResponse {
        try await get("api/voice/payments/client/\(clientId)/status")
    }

    /// POST /api/voice/payments/prepare
    ///
    /// Records NOTHING. Returns a draft id and the question to ask.
    func preparePayment(clientId: String, amount: Double, method: String?) async throws -> PaymentDraftResponse {
        var body: [String: Any] = ["client_id": clientId, "amount": amount]
        if let method { body["method"] = method }
        return try await post("api/voice/payments/prepare", body: body)
    }

    /// POST /api/voice/payments/confirm
    ///
    /// Sends ONE id. There is deliberately no amount parameter: if this call
    /// carried a figure, the sentence Siri read out and the number actually
    /// written would be two independent values, and the confirmation would
    /// guarantee nothing. The amount recorded is the one the server stored
    /// when it composed the question.
    func confirmPayment(draftId: String) async throws -> PaymentRecordedResponse {
        try await post("api/voice/payments/confirm", body: ["draft_id": draftId])
    }

    // MARK: - Transport

    /// One request path for every voice endpoint.
    ///
    /// Both callers above go through this, so authentication, timeouts and the
    /// status-code mapping exist once. A third endpoint adds a method here,
    /// not a second client.
    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await get(baseURL.appendingPathComponent(path))
    }

    /// The `spoken` field of an error body, when the server wrote one.
    ///
    /// Decoded defensively: an error page, an empty body or a proxy's HTML all
    /// have to come back as nil rather than throwing inside error handling.
    private static func spokenIn(_ data: Data) -> String? {
        struct Envelope: Decodable { let spoken: String? }
        guard let env = try? JSONDecoder().decode(Envelope.self, from: data),
              let spoken = env.spoken,
              !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return spoken
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        let payload: Data
        do {
            payload = try JSONSerialization.data(withJSONObject: body)
        } catch {
            throw VoiceAPIError.malformedResponse
        }
        return try await send(
            baseURL.appendingPathComponent(path), method: "POST", body: payload
        )
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        try await send(url, method: "GET", body: nil)
    }

    private func send<T: Decodable>(
        _ url: URL, method: String, body: Data?
    ) async throws -> T {
        guard let token = Keychain.get(account: Self.tokenAccount, accessGroup: accessGroup) else {
            throw VoiceAPIError.notSignedIn
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        // Siri gives an intent a short budget before it is considered stalled;
        // a request that outlives that is better failed than left hanging.
        request.timeoutInterval = 10

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw VoiceAPIError.network(underlying: error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw VoiceAPIError.malformedResponse
        }

        // A refusal the server phrased itself wins over anything this switch
        // would infer. It knows why it said no; a status code does not.
        if !(200...299).contains(http.statusCode),
           let spoken = Self.spokenIn(data) {
            throw VoiceAPIError.refused(spoken: spoken)
        }

        switch http.statusCode {
        case 200, 201:
            break
        case 400:
            // The server rejected the term's length. Distinct from a server
            // fault: the user can fix it by saying more of the name.
            throw VoiceAPIError.invalidQuery
        case 401:
            // The token expired or was revoked. Nothing is retried and nothing
            // is refreshed here: re-authentication belongs to the host app,
            // where the user can actually see what they are signing into.
            throw VoiceAPIError.unauthorized
        case 403:
            // A staff-only surface reached by a client account. Same remedy as
            // signing in, from the user's point of view.
            throw VoiceAPIError.unauthorized
        case 404:
            // Either the client is gone or it was never this studio's. The
            // server returns the same status for both on purpose and so does
            // this — see `.notFound`.
            throw VoiceAPIError.notFound
        case 429:
            throw VoiceAPIError.rateLimited
        default:
            throw VoiceAPIError.server(status: http.statusCode)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw VoiceAPIError.malformedResponse
        }
    }
}
