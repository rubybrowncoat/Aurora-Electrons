SELECT
	*
FROM
	FCT_PopulationInstallations as pi
inner JOIN
	DIM_PlanetaryInstallation as d
on
	d.PlanetaryInstallationID = pi.PlanetaryInstallationID
WHERE
	pi.PopID = 10264