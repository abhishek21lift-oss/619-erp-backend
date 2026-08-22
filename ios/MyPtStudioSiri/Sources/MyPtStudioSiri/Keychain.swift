import Foundation
import Security

/// The only place the session token is read from or written to.
///
/// ## Why the Keychain and not `UserDefaults`
///
/// An App Intent runs from a locked device, out of process from the app. The
/// token has to outlive the app's own lifetime and be reachable from the
/// intent, which rules out in-memory storage — and `UserDefaults` is a plist
/// in the app container, readable from a backup and not protected by the
/// passcode. The Keychain is the only store that is both.
///
/// ## The access policy is deliberate
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
///
/// - *AfterFirstUnlock* — an intent invoked from the lock screen must be able
///   to read the token. `WhenUnlocked` would make "Hey Siri" fail exactly when
///   it is most useful, and the fallback (open the app, unlock, try again) is
///   the whole feature gone.
/// - *ThisDeviceOnly* — the item is excluded from iCloud Keychain and from
///   encrypted backups, so a restore onto another device does not carry a live
///   studio session with it.
///
/// ## Sharing with the host app
///
/// `accessGroup` is the app group both the app and the intent extension
/// declare. Without it they get separate keychains and the intent never sees
/// the token the app stored. It is passed in rather than hardcoded because the
/// value contains the team identifier, which is deployment-specific — see
/// SIRI-INTEGRATION.md.
enum Keychain {

    enum KeychainError: Error {
        case unexpectedStatus(OSStatus)
    }

    /// Store (or replace) a value. Delete-then-add rather than `SecItemUpdate`
    /// so the accessibility attribute is re-applied every time; an update
    /// keeps whatever policy the original item was created with, which would
    /// silently preserve a weaker one.
    static func set(_ value: String, account: String, accessGroup: String?) throws {
        guard let data = value.data(using: .utf8) else { return }

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }

        SecItemDelete(query as CFDictionary)

        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }

    /// The stored value, or nil when there is none.
    ///
    /// A missing item is `nil` rather than an error: "not signed in yet" is an
    /// ordinary state the intent has to phrase for the user, not a failure.
    static func get(account: String, accessGroup: String?) -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else { return nil }

        return value
    }

    static func delete(account: String, accessGroup: String?) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        SecItemDelete(query as CFDictionary)
    }
}
