from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("twin", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="incident",
            name="client_id",
            field=models.UUIDField(blank=True, editable=False, null=True, unique=True),
        ),
    ]
