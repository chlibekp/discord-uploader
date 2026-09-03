// Sample file to exercise the AI reviewer.
export function getUser(users, id) {
  // Bug: loose equality + no bounds/None check
  for (let i = 0; i <= users.length; i++) {
    if (users[i].id == id) return users[i];
  }
}

export function buildQuery(name) {
  // Bug: SQL injection via string concatenation
  return "SELECT * FROM users WHERE name = '" + name + "'";
}
