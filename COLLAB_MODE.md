<h1 align="center">
  <sub>
    <img src="images/logo-1.png" height="48" alt="icon">
  </sub>
  <sup>
    &nbsp;PoiEx
  </sup>
</h1>

## Collaboration mode

PoiEx allows for real-time synchronization of findings and comments with other users. This mode requires a MongoDB instance shared across all collaborators. See the MongoDB section below for how to deploy a MongoDB instance.  

Once you have a shared MongoDB instance ready, set your name in _Settings > Extensions > PoiEx > Author Name_ and the database URI, which should be the same across all collaborators. <br> 
To create a project, the Project Manager should open the desired codebase in VS Code, then click _Init project_ in the PoiEx tab. If the project is encrypted, the automatically generated secret should be sent via a secure channel to all collaborators.  
To open an existing project, a collaborator should:
 - Ensure PoiEx is connected to the same MongoDB instance as the project manager
 - Ensure that in the PoiEx extension settings, the same MongoDB database name as the project manager is specified
 - Open a VS Code workspace with the same codebase as the project manager (the codebase is never uploaded to MongoDB and needs to be shared separately)
 - Click _Open existing project_ in the PoiEx tab
 - Select the project based on project name and project UUID
 - Enter the project secret, as received by the project manager

After this, all findings and notes will be synchronized in real-time across all collaborators.

### Shared MongoDB Instance

To enable collaboration features all collaborators should connect to a common MongoDB instance.<br>
All collaborators should have read and write access to the database configured in the `poiex.collab.database` field of the VSCode settings. To enable collaboration features set `poiex.collab.enabled` to `true` and `poiex.collab.uri` to the MongoDB URI. <br>
Optionally, update `poiex.collab.database` if using a database name different from the default value. If credentials are required to connect to the database, the extension will prompt the user for credentials. <br>
The extension supports an auto-delete feature, if `poiex.collab.expireAfter` is set to a value higher than `0`, it will configure MongoDB to automatically delete projects that are not accessed for the specified number of seconds. The project expiration value is reset each time one of the collaborators accesses the project. The expiration value does not affect project data that is saved locally. <br>
If a local project is not found on the remote database, the extension will push the local version to the remote database.

Example MongoDB deployment steps on Ubuntu 22.04:

```bash
export ADMIN_USERNAME="username"
export ADMIN_PASSWORD="$(openssl rand -base64 12)"
export FQDN="$(hostname)"
echo "Admin password is: $ADMIN_PASSWORD"

# Install MongoDB from the official repository
curl -fsSL https://pgp.mongodb.com/server-6.0.asc | \
   sudo gpg -o /usr/share/keyrings/mongodb-server-6.0.gpg \
   --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
apt update
apt install -y mongodb-org

# Create a new user and enable authentication
systemctl enable mongod
systemctl start mongod
mongosh <<< "admin = db.getSiblingDB(\"admin\"); admin.createUser({ user: \"$ADMIN_USERNAME\", pwd: \"$ADMIN_PASSWORD\", roles: [ { role: \"root\", db: \"admin\" } ]});"
systemctl stop mongod
echo "security:" >> /etc/mongod.conf
echo '  keyFile: "/etc/mongodb_keyfile"' >> /etc/mongod.conf
echo "  authorization: enabled" >> /etc/mongod.conf
openssl rand -base64 756 > /etc/mongodb_keyfile
chmod 400 /etc/mongodb_keyfile
chown mongodb:mongodb /etc/mongodb_keyfile

# Configure a replica set, we need this as the extension relies on changestreams
echo "replication:" >> /etc/mongod.conf
echo '  replSetName: "rs0"' >> /etc/mongod.conf
sed -i "s/127.0.0.1/0.0.0.0/g" /etc/mongod.conf
systemctl start mongod
mongosh -u "$ADMIN_USERNAME" -p "$ADMIN_PASSWORD" --authenticationDatabase "admin" <<< "rs.initiate()"
mongosh -u "$ADMIN_USERNAME" -p "$ADMIN_PASSWORD" --authenticationDatabase "admin" <<< "var x = rs.conf(); x.members[0].host = \"$FQDN:27017\"; rs.reconfig(x);"
```

**Security Note**: *The given deployment script is intended for plug&play purposes to test the extension and its collaboration capabilities. For production-safe usages, configure an hardened MongoDB instance machine depending on your needs by following the best practices (see the [documentation](https://www.mongodb.com/docs/manual/administration/security-checklist/))*

After deployment create additional user(s) for the extension collaborators. Each user should have read/write access to one common database. Each collaborator should enter the same MongoDB URI and database name in the extension settings.
### Security Model

Since the tool is intended internal usage, currently the MongoDB users (testers) are required to have read and write permissions on the configured database. <br>
Consequently, everyone in the team can list, add or destroy projects. <br>
As previously described, per-project symmetric encryption keys are created and they must be shared among peers participating to an activity in order to decrypt and read the stored data. In this way the confidentiality is project-oriented.
