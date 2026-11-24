import unittest

from hallucinations import is_hallucination


class HallucinationsTest(unittest.TestCase):
    def test_phrases_inventees_relevees_dans_nos_meets(self):
        for text in [
            "Merci d'avoir regardé cette vidéo.",
            "Merci d’avoir regardé cette vidéo !",
            "J'espère que vous avez apprécié cette vidéo.",
            "Sous-titrage ST'501",
            "S'il vous plaît, abonnez-vous à la chaîne, abonnez-vous à notre chaîne.",
            "Sous-titres réalisés par la communauté d'Amara.org",
            "Thank you for watching!",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_hallucination(text))

    def test_vraies_interventions_gardees(self):
        for text in [
            "Merci.",
            "OK.",
            "Mmh.",
            "Oui, mais il met des dates, j'ai vu un transcript tout à l'heure, regarde.",
            "Après, j'ai regardé le coin d'André et j'ai vu qu'il y a Romain et Guillermo",
            "Je sais pas, je vais pas regarder, tiens.",
            "Merci Claude pour les travaux.",
            "Tu peux regarder la vidéo de la démo que j'ai envoyée ?",
            "On s'abonne à quel topic Kafka ?",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_hallucination(text))


if __name__ == "__main__":
    unittest.main()
